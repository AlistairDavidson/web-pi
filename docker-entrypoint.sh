#!/bin/sh
# web-pi container entrypoint.
#
# App-on-volume: /app is seeded from the pristine image copy (/opt/web-pi)
# on FIRST BOOT ONLY — if /app already looks like the app, the volume wins
# and the image never clobbers it. Updates after that are the volume's
# business (git pull, npm install, pi sessions editing files).
#
# Dev mode bind-mounts the host repo over /app, which already contains
# package.json, so the seed step is skipped there too.
set -e

if [ ! -f /app/package.json ]; then
  echo "web-pi: first boot — seeding /app from the image copy"
  cp -a /opt/web-pi/. /app/
  echo "web-pi: seeded $(find /app -type f | wc -l) files"
fi

cd /app
exec "$@"
