# Virtual Onvif Server
This is a simple Virtual Onvif Server that was originally developed to work around limitations in the third party support of Unifi Protect.
It takes an existing RTSP Stream and builds a virtual Onvif device for it, so the stream can be consumed by Onvif compatible clients.

Currently only Onvif Profile S (Live Streaming) is implemented with limited functionality.

# Unifi Protect
Unifi Protect 5.0 introduced support for third party cameras that allow the user to add Onvif compatible cameras to their Unifi Protect system.

At the time of writing this, version 5.0.34 of Unifi Protect unfortunately has some limitations and does only support cameras with a single high- and low quality stream. Unfortunately video recorders that output multiple cameras (e.g. Hikvision / Dahua XVR) or cameras with multiple internal cameras are not properly supported.

Run this tool on a Raspberry Pi or similar to split up a multi-channel Onvif device into multiple virtual Onvif devices that work well with Unifi Protect 5.0.

## Raspberry Pi Setup

### Prerequisites
Ensure you are running Rapsberry OS 11 (Bullseye) or newer and have Node.js v16 or higher installed.

To check your version of Node.js run this command:
```bash
node -v
```

To install Node.js run these commands:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash

# Open a new Terminal / SSH connection
nvm install --lts
```

### Installation
To install all required dependencies run:
```bash
cd /path/to/onvif-server/
npm install
```

### Virtual Networks
To properly work with Unifi Protect each virtual Onvif device needs to have its own unique MAC address.
The easiest way to achieve this is by creating virtual network interfaces with the MacVLAN[^1] network driver:
```bash
ip link add [NAME] link [INTERFACE] address [MAC_ADDRESS] type macvlan mode bridge
```

> [!TIP]
> It is recommended to reserve fixed IP addresses in your DHCP server for your virtual networks.

Replace `[NAME]` with a name of your choosing (e.g. `onvif-proxy-1`) and `[MAC_ADDRESS]` with a locally administered MAC address[^2] (e.g. `a2:a2:a2:a2:a2:a1`) and `[INTERFACE]` with the name of the parent network interface (e.g. `eth0`).


#### Example to create four virtual networks:
```bash
# Setup the first virtual network with name "onvif-proxy-1" and MAC address "a2:a2:a2:a2:a2:a1":
sudo ip link add onvif-proxy-1 link eth0 address a2:a2:a2:a2:a2:a1 type macvlan mode bridge

# Setup the first virtual network with name "onvif-proxy-2" and MAC address "a2:a2:a2:a2:a2:a2":
sudo ip link add onvif-proxy-2 link eth0 address a2:a2:a2:a2:a2:a2 type macvlan mode bridge

# Setup the first virtual network with name "onvif-proxy-3" and MAC address "a2:a2:a2:a2:a2:a3":
sudo ip link add onvif-proxy-3 link eth0 address a2:a2:a2:a2:a2:a3 type macvlan mode bridge

# Setup the first virtual network with name "onvif-proxy-4" and MAC address "a2:a2:a2:a2:a2:a4":
sudo ip link add onvif-proxy-4 link eth0 address a2:a2:a2:a2:a2:a4 type macvlan mode bridge
```

> [!IMPORTANT]
> All virtual network settings will be lost when you reboot the server and will need to be redone!

## Configure Virtual Onvif Devices
The configuration can be automatically created by running:
```bash
node main.js --create-config
```
Enter the hostname and credentials of your real Onvif Camera server and copy/paste the generated configuration into a new file `config.yaml` and change the `<ONVIF PROXY MAC ADDRESS HERE>` fields to one of your virtual network MAC addresses each.

## Example Configuration
```yaml
onvif:
  - mac: a2:a2:a2:a2:a2:a1
    ports:
      server: 8081
      rtsp: 8554
      snapshot: 8580
    name: Channel1
    uuid: 15b21259-77d9-441f-9913-3ccd8a82e430
    highQuality:
      rtsp: /cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif
      snapshot: /onvif/snapshot?channel=1&subtype=0
      width: 2592
      height: 1944
      framerate: 12
      bitrate: 2048
      quality: 4
    lowQuality:
      rtsp: /cam/realmonitor?channel=1&subtype=1&unicast=true&proto=Onvif
      snapshot: /onvif/snapshot?channel=1&subtype=1
      width: 352
      height: 288
      framerate: 12
      bitrate: 160
      quality: 1
    target:
      hostname: 192.168.1.152
      ports:
        rtsp: 554
        snapshot: 80
```

The above configuration creates a virtual Onvif device that listens on port 8081 of the `a2:a2:a2:a2:a2:a1` virtual network and forwards the RTSP video streams and snapshots from `192.168.1.152` (the real Onvif server).

## Start Virtual Onvif Servers
Finally, to start the virtual Onvif devices run:
```bash
node main.js ./config.yaml
```

Your Virtual Onvif Devices should now automatically show up for adoption in Unifi Protect as "Onvif Cardinal" device. The username and password are the same as on the real Onvif device.


# Other Usages
This tool can also be used to create Onvif devices from regular RTSP streams by creating the configuration manually.


# Troubleshooting

- **All cameras show the same video stream in Unifi Protect**

Unifi Protect identifies cameras by their MAC address - if multiple cameras have the same MAC address they will be treated as the same.
It is possible your system is configured for all virtual network interfaces to report the same MAC address, to prevent this run these commands[^3]:
```bash
sudo sysctl -w net.ipv4.conf.all.arp_ignore=0
sudo sysctl -w net.ipv4.conf.all.arp_announce=0
```

- **Error: Wsse authorized time check failed.**

Try updating the date/time on your Onvif device to the current time.

- **I only see snapshots, no live-stream.**

Are you capturing the RTSP streams of your cameras elsewhere already? It is possible that you hit the maximum concurrent RTSP streams that your camera supports.

Unifi Protect also seems to only support h264 video streams at the moment. So ensure your real Onvif camera encodes videos with h264.


[^1]: [What is MacVLAN?](https://ipwithease.com/what-is-macvlan)
[^2]: [Wikipedia: Locally Administered MAC Address](https://en.wikipedia.org/wiki/MAC_address#:~:text=Locally%20administered%20addresses%20are%20distinguished,how%20the%20address%20is%20administered.)
[^3]: [Virtual Interfaces with different MAC addresses](https://serverfault.com/questions/682311/virtual-interfaces-with-different-mac-addresses)
