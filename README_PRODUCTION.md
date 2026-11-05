AnyCall - Production package (sources-only)
=========================================

This package contains the source code and Docker configuration to run the AnyCall
real-time voice + chat application locally or on a server. Node modules are not included.
Steps to run (on a machine with Docker & docker-compose):

1) Copy this folder to your server.
2) Edit `nginx/conf.d/anycall.conf` and set server_name to your domain (or leave _ for IP).
3) Configure coturn: add USER/PASS or long-term credentials as needed for TURN in production.
   The simple `coturn` service here is a placeholder; refer to coturn docs to configure.
4) Build & run:
   docker-compose build
   docker-compose up -d

5) Visit http://YOUR_SERVER_IP/ to open the client. Signaling websockets will be proxied to server.

Important notes:
- This package **does not** include node_modules and you must run builds inside docker (or run npm install locally).
- For reliable cross-network calling, set up TURN with valid credentials and external IP.
- Use TLS (nginx + certbot) in production. This compose is a basic starting point.

If you want, I can further help to create coturn config, production nginx TLS config, or provide
a pre-built docker image (but building images requires network access from your machine).

Created at: Mon Sep  8 17:57:16 2025
