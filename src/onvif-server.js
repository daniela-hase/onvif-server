const soap = require('soap');
const http = require('http');
const dgram = require('dgram');
const xml2js = require('xml2js');
const uuid = require('node-uuid');
const url = require('url');
const fs = require('fs');
const os = require('os');

Date.prototype.stdTimezoneOffset = function() {
    let jan = new Date(this.getFullYear(), 0, 1);
    let jul = new Date(this.getFullYear(), 6, 1);
    return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

Date.prototype.isDstObserved = function() {
    return this.getTimezoneOffset() < this.stdTimezoneOffset();
}

function getIpAddressFromMac(macAddress) {
    let networkInterfaces = os.networkInterfaces();
    for (let interface in networkInterfaces)
        for (let network of networkInterfaces[interface])
            if (network.family == 'IPv4' && network.mac.toLowerCase() == macAddress.toLowerCase())
                return network.address;
    return null;
}

class OnvifServer {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;

        if (!this.config.hostname)
            this.config.hostname = getIpAddressFromMac(this.config.mac);

        this.realPtzProfileToken = null;
        this.ptzTarget = null;

        this.audioConfig = null;
        if (this.config.audio) {
            let audio = typeof this.config.audio === 'object' ? this.config.audio : {};
            this.audioConfig = {
                encoding: audio.encoding || 'AAC',
                bitrate: audio.bitrate || 64,
                samplerate: audio.samplerate || 16
            };
            this.audioSource = {
                attributes: {
                    token: 'audio_src_token'
                },
                Channels: 1
            };
            this.audioSourceConfiguration = {
                attributes: {
                    token: 'audio_src_config_token'
                },
                Name: 'AudioSource',
                UseCount: 2,
                SourceToken: 'audio_src_token'
            };
            this.audioEncoderConfiguration = {
                attributes: {
                    token: 'audio_encoder_config_token'
                },
                Name: 'CardinalAudioConfiguration',
                UseCount: 2,
                Encoding: this.audioConfig.encoding,
                Bitrate: this.audioConfig.bitrate,
                SampleRate: this.audioConfig.samplerate,
                SessionTimeout: 'PT1000S'
            };
        }

        this.videoSource = {
            attributes: {
                token: 'video_src_token'
            },
            Framerate: this.config.highQuality.framerate,
            Resolution: { Width: this.config.highQuality.width, Height: this.config.highQuality.height }
        };
    
        this.profiles = [
            {
                Name: 'MainStream',
                attributes: {
                    token: 'main_stream'
                },
                VideoSourceConfiguration: {
                    Name: 'VideoSource',
                    UseCount: 2,
                    attributes: {
                        token: 'video_src_config_token'
                    },
                    SourceToken: 'video_src_token',
                    Bounds: { attributes: { x: 0, y: 0, width: this.config.highQuality.width, height: this.config.highQuality.height } }
                },
                VideoEncoderConfiguration: {
                    attributes: {
                        token: 'encoder_hq_config_token'
                    },
                    Name: 'CardinalHqCameraConfiguration',
                    UseCount: 1,
                    Encoding: 'H264',
                    Resolution: {
                        Width: this.config.highQuality.width,
                        Height: this.config.highQuality.height
                    },
                    Quality: this.config.highQuality.quality,
                    RateControl: {
                        FrameRateLimit: this.config.highQuality.framerate,
                        EncodingInterval: 1,
                        BitrateLimit: this.config.highQuality.bitrate
                    },
                    H264: {
                        GovLength: this.config.highQuality.framerate,
                        H264Profile: 'Main'
                    },
                    SessionTimeout: 'PT1000S'
                }
            }
        ];

        if (this.config.lowQuality) {
            this.profiles.push(
                {
                    Name: 'SubStream',
                    attributes: {
                        token: 'sub_stream'
                    },
                    VideoSourceConfiguration: {
                        Name: 'VideoSource',
                        UseCount: 2,
                        attributes: {
                            token: 'video_src_config_token'
                        },
                        SourceToken: 'video_src_token',
                        Bounds: { attributes: { x: 0, y: 0, width: this.config.highQuality.width, height: this.config.highQuality.height } }
                    },
                    VideoEncoderConfiguration: {
                        attributes: {
                            token: 'encoder_lq_config_token'
                        },
                        Name: 'CardinalLqCameraConfiguration',
                        UseCount: 1,
                        Encoding: 'H264',
                        Resolution: {
                            Width: this.config.lowQuality.width,
                            Height: this.config.lowQuality.height
                        },
                        Quality: this.config.lowQuality.quality,
                        RateControl: {
                            FrameRateLimit: this.config.lowQuality.framerate,
                            EncodingInterval: 1,
                            BitrateLimit: this.config.lowQuality.bitrate
                        },
                        H264: {
                            GovLength: this.config.lowQuality.framerate,
                            H264Profile: 'Main'
                        },
                        SessionTimeout: 'PT1000S'
                    }
                }
            );
        }
        
        if (this.audioConfig) {
            this.profiles = this.profiles.map((profile) => ({
                Name: profile.Name,
                attributes: profile.attributes,
                VideoSourceConfiguration: profile.VideoSourceConfiguration,
                AudioSourceConfiguration: this.audioSourceConfiguration,
                VideoEncoderConfiguration: profile.VideoEncoderConfiguration,
                AudioEncoderConfiguration: this.audioEncoderConfiguration
            }));
        }

        this.onvif = {
            DeviceService: {
                Device: {
                    GetSystemDateAndTime: (args) => {
                        let now = new Date();
            
                        let offset = now.getTimezoneOffset();
                        let abs_offset = Math.abs(offset);
                        let hrs_offset = Math.floor(abs_offset / 60);
                        let mins_offset = (abs_offset % 60);
                        let tz = 'UTC' + (offset < 0 ? '-' : '+') + hrs_offset + (mins_offset === 0 ? '' : ':' + mins_offset);
            
                        return {
                            SystemDateAndTime: {
                                DateTimeType: 'NTP',
                                DaylightSavings: now.isDstObserved(),
                                TimeZone: {
                                    TZ: tz
                                },
                                UTCDateTime: {
                                    Time: { Hour: now.getUTCHours(), Minute: now.getUTCMinutes(), Second: now.getUTCSeconds() },
                                    Date: { Year: now.getUTCFullYear(), Month: now.getUTCMonth() + 1, Day: now.getUTCDate() }
                                },
                                LocalDateTime: {
                                    Time: { Hour: now.getHours(), Minute: now.getMinutes(), Second: now.getSeconds() },
                                    Date: { Year: now.getFullYear(), Month: now.getMonth() + 1, Day: now.getDate() }
                                },
                                Extension: {}
                            }
                        };
                    },
        
                    GetCapabilities: (args) => {
                        let response = {
                            Capabilities: {}
                        };
                
                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Device') {
                            response.Capabilities['Device'] = {
                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`,
                                Network: {
                                    IPFilter: false,
                                    ZeroConfiguration: false,
                                    IPVersion6: false,
                                    DynDNS: false,
                                    Extension: {
                                        Dot11Configuration: false,
                                        Extension: {}
                                    }
                                },
                                System: {
                                    DiscoveryResolve: false,
                                    DiscoveryBye: false,
                                    RemoteDiscovery: false,
                                    SystemBackup: false,
                                    SystemLogging: false,
                                    FirmwareUpgrade: false,
                                    SupportedVersions: {
                                        Major: 2,
                                        Minor: 5
                                    },
                                    Extension: {
                                        HttpFirmwareUpgrade: false,
                                        HttpSystemBackup: false,
                                        HttpSystemLogging: false,
                                        HttpSupportInformation: false,
                                        Extension: {}
                                    }
                                },
                                IO: {
                                    InputConnectors: 0,
                                    RelayOutputs: 1,
                                    Extension: {
                                        Auxiliary: false,
                                        AuxiliaryCommands: '',
                                        Extension: {}
                                    }
                                },
                                Security: {
                                    'TLS1.1': false,
                                    'TLS1.2': false,
                                    OnboardKeyGeneration: false,
                                    AccessPolicyConfig: false,
                                    'X.509Token': false,
                                    SAMLToken: false,
                                    KerberosToken: false,
                                    RELToken: false,
                                    Extension: {
                                        'TLS1.0': false,
                                        Extension: {
                                            Dot1X: false,
                                            RemoteUserHandling: false
                                        }
                                    }
                                },
                                Extension: {}
                            };
                        }
                        if (this.config.ptz && (args.Category === undefined || args.Category == 'All' || args.Category == 'PTZ')) {
                            response.Capabilities['PTZ'] = {
                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/ptz_service`
                            };
                        }
                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Media') {
                            response.Capabilities['Media'] = {
                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service`,
                                StreamingCapabilities: {
                                    RTPMulticast: false,
                                    RTP_TCP: true,
                                    RTP_RTSP_TCP: true,
                                    Extension: {}
                                },
                                Extension: {
                                    ProfileCapabilities: {
                                        MaximumNumberOfProfiles: this.profiles.length
                                    }
                                }
                            }
                        }

                        return response;
                    },
        
                    GetServices: (args) => {
                        let services = [
                                {
                                    Namespace : 'http://www.onvif.org/ver10/device/wsdl',
                                    XAddr : `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`,
                                    Version : { 
                                        Major : 2,
                                        Minor : 5,
                                    }
                                },
                                { 
                                    Namespace : 'http://www.onvif.org/ver10/media/wsdl',
                                    XAddr : `http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service`,
                                    Version : { 
                                        Major : 2,
                                        Minor : 5,
                                    }
                                }
                            ];

                        if (this.config.ptz) {
                            services.push({
                                Namespace : 'http://www.onvif.org/ver20/ptz/wsdl',
                                XAddr : `http://${this.config.hostname}:${this.config.ports.server}/onvif/ptz_service`,
                                Version : {
                                    Major : 2,
                                    Minor : 5,
                                }
                            });
                        }

                        return {
                            Service : services
                        };
                    },
                
                    GetDeviceInformation: (args) => {
                        return {
                            Manufacturer: 'Onvif',
                            Model: 'Cardinal',
                            FirmwareVersion: '1.0.0',
                            SerialNumber: `${this.config.name.replace(' ', '_')}-0000`,
                            HardwareId: `${this.config.name.replace(' ', '_')}-1001`
                        };
                    }
                
                }
            },
        
            MediaService: {
                Media: {
                    GetProfiles: (args) => {
                        return {
                            Profiles: this.profiles
                        };
                    },
        
                    GetVideoSources: (args) => {
                        return {
                            VideoSources: [
                                this.videoSource
                            ]
                        };
                    },

                    GetAudioSources: (args) => {
                        return {
                            AudioSources: this.audioConfig ? [ this.audioSource ] : []
                        };
                    },

                    GetAudioSourceConfigurations: (args) => {
                        return {
                            Configurations: this.audioConfig ? [ this.audioSourceConfiguration ] : []
                        };
                    },

                    GetAudioEncoderConfigurations: (args) => {
                        return {
                            Configurations: this.audioConfig ? [ this.audioEncoderConfiguration ] : []
                        };
                    },

                    GetAudioEncoderConfiguration: (args) => {
                        if (this.audioConfig)
                            return { Configuration: this.audioEncoderConfiguration };
                        return {};
                    },

                    GetAudioEncoderConfigurationOptions: (args) => {
                        if (!this.audioConfig)
                            return { Options: {} };
                        return {
                            Options: {
                                Options: [
                                    {
                                        Encoding: this.audioConfig.encoding,
                                        BitrateList: { Items: [ this.audioConfig.bitrate ] },
                                        SampleRateList: { Items: [ this.audioConfig.samplerate ] }
                                    }
                                ]
                            }
                        };
                    },
        
                    GetSnapshotUri: (args) => {
                        let uri = `http://${this.config.hostname}:${this.config.ports.server}/snapshot.png`;
                        if (args.ProfileToken == 'sub_stream' && this.config.lowQuality && this.config.lowQuality.snapshot)
                            uri = `http://${this.config.hostname}:${this.config.ports.snapshot}${this.config.lowQuality.snapshot}`;
                        else if (this.config.highQuality.snapshot)
                            uri = `http://${this.config.hostname}:${this.config.ports.snapshot}${this.config.highQuality.snapshot}`;

                        return {
                            MediaUri : {
                                Uri: uri,
                                InvalidAfterConnect : false,
                                InvalidAfterReboot : false,
                                Timeout : 'PT30S'
                            }
                        };
                    },
                
                    GetStreamUri: (args) => {
                        let path = this.config.highQuality.rtsp;
                        if (args.ProfileToken == 'sub_stream' && this.config.lowQuality)
                            path = this.config.lowQuality.rtsp;

                        return {
                            MediaUri: {
                                Uri: `rtsp://${this.config.hostname}:${this.config.ports.rtsp}${path}`,
                                InvalidAfterConnect: false,
                                InvalidAfterReboot: false,
                                Timeout: 'PT30S'
                            }
                        };
                    }
                }
            }
        };
    }

    listen(request, response) {
        let action = url.parse(request.url, true).pathname;
        if (action == '/snapshot.png') {
            let image = fs.readFileSync('./resources/snapshot.png');
            response.writeHead(200, {'Content-Type': 'image/png' });
            response.end(image, 'binary');
        } else if (this.config.ptz && action == '/onvif/ptz_service' && request.method == 'POST') {
            this.relayPtz(request, response);
        } else {
            response.writeHead(404, {'Content-Type': 'text/plain'});
            response.write('404 Not Found\n');
            response.end();
        }
    }

    relayPtz(request, response) {
        let chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            if (!this.ptzTarget) {
                response.writeHead(502, {'Content-Type': 'text/plain'});
                response.end('PTZ passthrough not initialized\n');
                return;
            }

            let body = Buffer.concat(chunks).toString('utf8');

            // Rewrite our virtual profile tokens to the camera's real PTZ profile token.
            // All other tokens (configuration, node, preset) originate from the camera
            // via relayed responses and are passed through untouched.
            if (this.realPtzProfileToken) {
                body = body.replace(
                    /(<[^>]*ProfileToken[^>]*>)\s*(?:main_stream|sub_stream)\s*(<\/[^>]*ProfileToken[^>]*>)/g,
                    `$1${this.realPtzProfileToken}$2`
                );
            }

            const relayRequest = http.request({
                hostname: this.ptzTarget.hostname,
                port: this.ptzTarget.port,
                path: this.ptzTarget.path,
                method: 'POST',
                headers: {
                    'Content-Type': request.headers['content-type'] || 'application/soap+xml; charset=utf-8',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (relayResponse) => {
                this.logger.debug(`PtzService: relayed request -> ${relayResponse.statusCode}`);
                response.writeHead(relayResponse.statusCode, {
                    'Content-Type': relayResponse.headers['content-type'] || 'application/soap+xml; charset=utf-8'
                });
                relayResponse.pipe(response);
            });

            relayRequest.setTimeout(10000, () => relayRequest.destroy(new Error('PTZ relay timeout')));
            relayRequest.on('error', (err) => {
                this.logger.error(`PtzService: relay error: ${err.message}`);
                if (!response.headersSent)
                    response.writeHead(502, {'Content-Type': 'text/plain'});
                response.end();
            });

            relayRequest.end(body);
        });
    }

    async startPtz() {
        const ptzConfig = this.config.ptz;
        const onvifPort = ptzConfig.port || 8000;
        const endpoint = `http://${this.config.target.hostname}:${onvifPort}/onvif/device_service`;

        const options = { forceSoap12Headers: true };
        const securityOptions = { hasNonce: true, passwordType: 'PasswordDigest' };

        // Discover the camera's PTZ-capable media profile.
        let mediaClient = await soap.createClientAsync('./wsdl/media_service.wsdl', options);
        mediaClient.setEndpoint(endpoint);
        mediaClient.setSecurity(new soap.WSSecurity(ptzConfig.username, ptzConfig.password, securityOptions));

        let profiles = (await mediaClient.GetProfilesAsync({}))[0].Profiles;
        let realProfile = null;
        for (let profile of profiles) {
            if (!profile.PTZConfiguration)
                continue;
            if (ptzConfig.profileToken) {
                if (profile.attributes.token === ptzConfig.profileToken) {
                    realProfile = profile;
                    break;
                }
            } else {
                realProfile = profile;
                break;
            }
        }

        if (!realProfile)
            throw new Error('No camera media profile with a PTZConfiguration was found' +
                (ptzConfig.profileToken ? ` (matching token '${ptzConfig.profileToken}')` : ''));

        this.realPtzProfileToken = realProfile.attributes.token;

        // Embed the camera's real PTZConfiguration into our virtual profiles so
        // clients detect PTZ capability; its tokens are valid on the relayed service.
        for (let profile of this.profiles)
            profile.PTZConfiguration = realProfile.PTZConfiguration;

        // Discover the camera's real PTZ service endpoint.
        let deviceClient = await soap.createClientAsync('./wsdl/device_service.wsdl', options);
        deviceClient.setEndpoint(endpoint);
        deviceClient.setSecurity(new soap.WSSecurity(ptzConfig.username, ptzConfig.password, securityOptions));

        let ptzPath = '/onvif/ptz_service';
        let ptzPort = onvifPort;
        try {
            let capabilities = (await deviceClient.GetCapabilitiesAsync({ Category: 'PTZ' }))[0];
            if (capabilities && capabilities.Capabilities && capabilities.Capabilities.PTZ && capabilities.Capabilities.PTZ.XAddr) {
                let xaddr = url.parse(capabilities.Capabilities.PTZ.XAddr);
                ptzPath = xaddr.pathname || ptzPath;
                ptzPort = parseInt(xaddr.port) || (xaddr.protocol === 'https:' ? 443 : 80);
            }
        } catch (err) {
            this.logger.warn(`PtzService: GetCapabilities(PTZ) failed (${err.message}), assuming ${ptzPath} on port ${ptzPort}`);
        }

        // Always contact the camera at its configured hostname, regardless of
        // what host the camera put in its XAddr.
        this.ptzTarget = {
            hostname: this.config.target.hostname,
            port: ptzPort,
            path: ptzPath
        };

        return this.realPtzProfileToken;
    }

    startServer() {
        this.server = http.createServer((request, response) => this.listen(request, response));

        this.server.listen(this.config.ports.server, this.config.hostname);

        this.deviceService = soap.listen(this.server, {
            path: '/onvif/device_service', 
            services: this.onvif,
            xml: fs.readFileSync('./wsdl/device_service.wsdl', 'utf8'),
            forceSoap12Headers: true
        });

        this.mediaService = soap.listen(this.server, {
            path: '/onvif/media_service', 
            services: this.onvif,
            xml: fs.readFileSync('./wsdl/media_service.wsdl', 'utf8'),
            forceSoap12Headers: true
        });
    }

    enableDebugOutput() {
        this.deviceService.on('request', (request, methodName) => {
            this.logger.debug('DeviceService: ' + methodName);
        });
        
        this.mediaService.on('request', (request, methodName) => {
            this.logger.debug('MediaService: ' + methodName);
        });
    }

    startDiscovery() {
        this.discoveryMessageNo = 0;
        this.discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        
        this.discoverySocket.on('message', (message, remote) => {
            this.logger.debug(`Discovery Server: ${this.config.name} - Discovery request from ${remote.address}:${remote.port}`);

            xml2js.parseString(message.toString(), { tagNameProcessors: [xml2js['processors'].stripPrefix] }, (err, result) => {
                let probeUuid = result['Envelope']['Header'][0]['MessageID'][0];
                let probeType = '';
                try {
                    probeType = result['Envelope']['Body'][0]['Probe'][0]['Types'][0];
                } catch (err) {
                    probeType = '';
                }

                if (typeof probeType === 'object')
                    probeType = probeType._;
            
                if (typeof probeUuid === 'object')
                    probeUuid = probeUuid._;

                if (probeType === '' || probeType.indexOf('NetworkVideoTransmitter') > -1) {
                    let response = 
                       `<?xml version="1.0" encoding="UTF-8"?>
                        <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
                            <SOAP-ENV:Header>
                                <wsa:MessageID>uuid:${uuid.v1()}</wsa:MessageID>
                                <wsa:RelatesTo>${probeUuid}</wsa:RelatesTo>
                                <wsa:To SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
                                <wsa:Action SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
                                <d:AppSequence SOAP-ENV:mustUnderstand="true" MessageNumber="${this.discoveryMessageNo}" InstanceId="1234567890"/>
                            </SOAP-ENV:Header>
                            <SOAP-ENV:Body>
                                <d:ProbeMatches>
                                    <d:ProbeMatch>
                                        <wsa:EndpointReference>
                                            <wsa:Address>urn:uuid:${this.config.uuid}</wsa:Address>
                                        </wsa:EndpointReference>
                                        <d:Types>dn:NetworkVideoTransmitter</d:Types>
                                        <d:Scopes>
                                            onvif://www.onvif.org/type/video_encoder
                                            onvif://www.onvif.org/type/ptz
                                            onvif://www.onvif.org/hardware/Onvif
                                            onvif://www.onvif.org/name/Cardinal
                                            onvif://www.onvif.org/location/
                                        </d:Scopes>
                                        <d:XAddrs>http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service</d:XAddrs>
                                        <d:MetadataVersion>1</d:MetadataVersion>
                                    </d:ProbeMatch>
                                </d:ProbeMatches>
                            </SOAP-ENV:Body>
                        </SOAP-ENV:Envelope>`;

                    this.discoveryMessageNo++;
                    let responseBuffer = Buffer.from(response);
                    return dgram.createSocket('udp4').send(responseBuffer, 0, responseBuffer.length, remote.port, remote.address);
                }
            });
        });
        
        this.discoverySocket.bind(3702, () => {
            return this.discoverySocket.addMembership('239.255.255.250', this.config.hostname);
        });
    }

    getHostname() {
        return this.config.hostname;
    }
};

function createServer(config, logger) {
    return new OnvifServer(config, logger);
}

exports.createServer = createServer;
