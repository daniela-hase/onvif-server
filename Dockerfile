FROM node:22-alpine

ADD . /app
WORKDIR /app
RUN npm install

ENTRYPOINT node main.js /onvif.yaml
