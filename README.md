# NeoPin

<p>NeoPin is an Open-Source Geo Tracker that aims to replace the Google Maps Location Sharing.</p>
---
## Installation
To install Neopin you can use Docker Compose or the Dockerfile.

Docker Compose:
```yaml
services:
  neopin_server:
    image: node:22
    command: sh -c "apt-get update && apt-get install -y git && [ ! -d /app/neopin/.git ] && git clone -b server https://vxnsin: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@github.com/vxnsin/NeoPin.git /app/neopin || (cd /app/neopin && git pull) && cd /app/neopin && npm install && node server.js"
    working_dir: /app/neopin
    ports:
      - "3012:3012"
    volumes:
      - ./:/app
    environment:
      - PORT=3012
      - PASSWORD=neopin123
```
