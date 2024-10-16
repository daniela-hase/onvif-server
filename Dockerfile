FROM node:22-alpine

ADD . /app
WORKDIR /app

ENTRYPOINT node main.js /onvif.yaml