const soap = require('soap');
const uuid = require('node-uuid');

function extractPath(url) {
    return url.substr(url.indexOf('/', url.indexOf('//') + 2));
}

async function createConfig(hostname, username, password) {
    let options = {
        forceSoap12Headers: true
    };

    let securityOptions = {
        hasNonce: true,
        passwordType: 'PasswordDigest'
    };
    
    let client = await soap.createClientAsync('./wsdl/media_service.wsdl', options);
    client.setEndpoint(`http://${hostname}/onvif/device_service`);
    client.setSecurity(new soap.WSSecurity(username, password, securityOptions));

    let hostport = 80;
    if (hostname.indexOf(':') > -1) {
        hostport = parseInt(hostname.substr(hostname.indexOf(':') + 1));
        hostname = hostname.substr(0, hostname.indexOf(':'));
    }

    let cameras = {};

    try {
        let profiles = await client.GetProfilesAsync({});
        for (let profile of profiles[0].Profiles) {
            let videoSource = profile.VideoSourceConfiguration.SourceToken;

            if (!cameras[videoSource])
                cameras[videoSource] = [];

            let snapshotUri = await client.GetSnapshotUriAsync({
                ProfileToken: profile.attributes.token
            });

            let streamUri = await client.GetStreamUriAsync({
                StreamSetup: {
                    Stream: 'RTP-Unicast',
                    Transport: {
                        Protocol: 'RTSP'
                    }
                },
                ProfileToken: profile.attributes.token
            });

            profile.streamUri = streamUri[0].MediaUri.Uri;
            profile.snapshotUri = snapshotUri[0].MediaUri.Uri;
            cameras[videoSource].push(profile);
        }
    } catch (err) {
        if (err.root && err.root.Envelope && err.root.Envelope.Body && err.root.Envelope.Body.Fault && err.root.Envelope.Body.Fault.Reason && err.root.Envelope.Body.Fault.Reason.Text)
            throw `Error: ${err.root.Envelope.Body.Fault.Reason.Text['$value']}`;
        throw `Error: ${err.message}`;
    }

    let config = {
        onvif: []
    };

    let serverPort = 8081;
    for (let camera in cameras) {
        let mainStream = cameras[camera][0];
        let subStream = cameras[camera][cameras[camera].length > 1 ? 1 : 0];

        let swapStreams = false;
        if (subStream.VideoEncoderConfiguration.Quality > mainStream.VideoEncoderConfiguration.Quality)
            swapStreams = true;
        else if (subStream.VideoEncoderConfiguration.Quality == mainStream.VideoEncoderConfiguration.Quality)
            if (subStream.VideoEncoderConfiguration.Resolution.Width > mainStream.VideoEncoderConfiguration.Resolution.Width)
                swapStreams = true;

        if (swapStreams) {
            let tempStream = subStream;
            subStream = mainStream;
            mainStream = tempStream;
        }

        let cameraConfig = {
            mac: '<ONVIF PROXY MAC ADDRESS HERE>',
            ports: {
                server: serverPort,
                rtsp: 8554,
                snapshot: 8580
            },
            name: mainStream.VideoSourceConfiguration.Name,
            uuid: uuid.v4(),
            highQuality: {
                rtsp: extractPath(mainStream.streamUri),
                snapshot: extractPath(mainStream.snapshotUri),
                width: mainStream.VideoEncoderConfiguration.Resolution.Width,
                height: mainStream.VideoEncoderConfiguration.Resolution.Height,
                framerate: mainStream.VideoEncoderConfiguration.RateControl.FrameRateLimit,
                bitrate: mainStream.VideoEncoderConfiguration.RateControl.BitrateLimit,
                quality: 4.0
            },
            lowQuality: {
                rtsp: extractPath(subStream.streamUri),
                snapshot: extractPath(subStream.snapshotUri),
                width: subStream.VideoEncoderConfiguration.Resolution.Width,
                height: subStream.VideoEncoderConfiguration.Resolution.Height,
                framerate: subStream.VideoEncoderConfiguration.RateControl.FrameRateLimit,
                bitrate: subStream.VideoEncoderConfiguration.RateControl.BitrateLimit,
                quality: 1.0
            },
            target: {
                hostname: hostname,
                ports: {
                    rtsp: 554,
                    snapshot: hostport
                }
            }
        };

        config.onvif.push(cameraConfig);
        serverPort++;
    }

    return config;
}

exports.createConfig = async function(hostname, username, password) {

    let config;
    try {
        config = await createConfig(hostname, username, password);
    } catch (err) {
        console.log(err);
        if (err.includes('time check failed')) {
            console.log('Retrying...')

            var utcHours = (new Date()).getUTCHours();
            Date.prototype.getUTCHours = function() {
                return utcHours + 1;
            }

            try {
                config = await createConfig(hostname, username, password);
            } catch (err) {
                console.log(err);
            }
        }
    }

    return config;
}
