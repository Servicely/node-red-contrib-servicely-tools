#!/usr/bin/env bash

WORKINGDIR="`pwd`/_docker_config_volume"
PLUGINDIR="`pwd`/"

mkdir -p _docker_config_volume

/Applications/Docker.app/Contents/Resources/bin/docker rm -f nodered-tools

/Applications/Docker.app/Contents/Resources/bin/docker run \
  -p 1880:1880 \
  -v "${WORKINGDIR}:/data" \
  -v "${PLUGINDIR}:/plugin" \
  --name nodered-tools \
  nodered/node-red
