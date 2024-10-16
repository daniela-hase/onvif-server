const tcpProxy = require('node-tcp-proxy');
const onvifServer = require('./src/onvif-server');
const configBuilder = require('./src/config-builder');
const package = require('./package.json');
const argparse = require('argparse');
const readline = require('readline');
const stream = require('stream');
const yaml = require('yaml');
const fs = require('fs');

const parser = new argparse.ArgumentParser({
    description: 'Virtual Onvif Server'
});

parser.add_argument('-v', '--version', { action: 'store_true', help: 'show the version information' });
parser.add_argument('-cc', '--create-config', { action: 'store_true', help: 'create a new config' });
parser.add_argument('-d', '--debug', { action: 'store_true', help: 'show onvif requests' });
parser.add_argument('config', { help: 'config filename to use', nargs: '?'});

let args = parser.parse_args();

if (args) {
    if (args.version) {
        console.log('Version: ' + package.version);
        return;
    }

    if (args.create_config) {
        let mutableStdout = new stream.Writable({
            write: function(chunk, encoding, callback) {
                if (!this.muted || chunk.toString().includes('\n'))
                    process.stdout.write(chunk, encoding);
                callback();
            }
        });

        const rl = readline.createInterface({
            input: process.stdin,
            output: mutableStdout,
            terminal: true
        });

        mutableStdout.muted = false;
        rl.question('Onvif Server: ', (hostname) => {
            rl.question('Onvif Username: ', (username) => {
                mutableStdout.muted = true;
                process.stdout.write('Onvif Password: ');
                rl.question('', (password) => {
                    console.log('Generating config ...');
                    configBuilder.createConfig(hostname, username, password).then((config) => {
                        if (config) {
                            console.log('# ==================== CONFIG START ====================');
                            console.log(yaml.stringify(config));
                            console.log('# ===================== CONFIG END =====================');
                        } else
                            console.log('Failed to create config!');
                    });
                    rl.close();
                });
            });
        });

    } else if (args.config) {
        let configData;
        try {
            configData = fs.readFileSync(args.config, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('File not found: ' + args.config);
                return -1;
            }
            throw error;
        }

        let config;
        try {
            config = yaml.parse(configData);
        } catch (error) {
            console.log('Failed to read config, invalid yaml syntax.')
            return -1;
        }

        let proxies = {};

        for (let onvifConfig of config.onvif) {
            let server = onvifServer.createServer(onvifConfig);
            if (server.getHostname()) {
                console.log(`Starting virtual onvif server for ${onvifConfig.name} on ${server.getHostname()}:${onvifConfig.ports.server} ...`);
                server.startServer();
                server.startDiscovery();
                if (args.debug)
                    server.enableDebugOutput();
                console.log('  Started!');
                console.log('');

                if (!proxies[onvifConfig.target.hostname])
                    proxies[onvifConfig.target.hostname] = {}
                
                if (onvifConfig.ports.rtsp && onvifConfig.target.ports.rtsp)
                    proxies[onvifConfig.target.hostname][onvifConfig.ports.rtsp] = onvifConfig.target.ports.rtsp;
                if (onvifConfig.ports.snapshot && onvifConfig.target.ports.snapshot)
                    proxies[onvifConfig.target.hostname][onvifConfig.ports.snapshot] = onvifConfig.target.ports.snapshot;
            } else {
                console.log(`Failed to find IP address for MAC address ${onvifConfig.mac}`)
                return -1;
            }
        }
        
        for (let destinationAddress in proxies) {
            for (let sourcePort in proxies[destinationAddress]) {
                console.log(`Starting tcp proxy from port ${sourcePort} to ${destinationAddress}:${proxies[destinationAddress][sourcePort]} ...`);
                tcpProxy.createProxy(sourcePort, destinationAddress, proxies[destinationAddress][sourcePort]);
                console.log('  Started!');
                console.log('');
            }
        }

    } else {
        console.log('Please specifiy a config filename!');
        return -1;
    }

    return 0;
}


/*

// Setup Virtal Interfaces
ip link add macvlan-241 link br0 type macvlan mode bridge
ip link set macvlan-241 address 7a:07:57:78:d0:e1
ip addr add 192.168.1.241 dev macvlan-241
ip link set macvlan-241 up

ip link add macvlan-242 link br0 type macvlan mode bridge
ip link set macvlan-242 address fa:93:6e:ee:0a:8d
ip addr add 192.168.1.242 dev macvlan-242
ip link set macvlan-242 up

ip link add macvlan-243 link br0 type macvlan mode bridge
ip link set macvlan-243 address 1e:84:0d:b3:97:ab
ip addr add 192.168.1.243 dev macvlan-243
ip link set macvlan-243 up

ip link add macvlan-244 link br0 type macvlan mode bridge
ip link set macvlan-244 address 22:63:cc:4c:9a:7b
ip addr add 192.168.1.244 dev macvlan-244
ip link set macvlan-244 up

sysctl -w net.ipv4.conf.all.arp_ignore=1
sysctl -w net.ipv4.conf.all.arp_announce=2


// Revert all changes
ip link set macvlan-241 down
ip addr del 192.168.1.241 dev macvlan-241
ip link del macvlan-241

ip link set macvlan-242 down
ip addr del 192.168.1.242 dev macvlan-242
ip link del macvlan-242

ip link set macvlan-243 down
ip addr del 192.168.1.243 dev macvlan-243
ip link del macvlan-243

ip link set macvlan-244 down
ip addr del 192.168.1.244 dev macvlan-244
ip link del macvlan-244

sysctl -w net.ipv4.conf.all.arp_ignore=0
sysctl -w net.ipv4.conf.all.arp_announce=0


https://serverfault.com/questions/682311/virtual-interfaces-with-different-mac-addresses
*/


