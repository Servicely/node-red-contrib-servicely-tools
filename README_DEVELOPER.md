# Servicely connector for Node-RED

A beta implementation of a set of Node-RED nodes to facilitate integration with the Servicely Asynchronous
Queue/Actions.

## Development

ls servicely-* | entr -r ./docker_run.sh

## Development PF

Start the container:

ls servicely-* | entr -r ./docker_run.sh

Gain an interactive shell:

docker exec -it nodered /bin/bash

Go to data directory

cd /data

Add local project as a set of nodes:

npm i --save node-red-contrib-servicely-tools@/plugin

# Install

docker exec -it nodered /bin/bash

cd /data

npm i --save node-red-contrib-servicely-tools

# Publishing

npm publish . 
