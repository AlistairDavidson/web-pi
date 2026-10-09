#!/bin/sh
# web-pi container entrypoint — app-on-volume update policy.
#
#   first boot (/app empty)   → seed everything from the image copy
#   /app is a git checkout    → operator owns updates (git pull, rebuild);
#                               the image never syncs over it
#   image content changed     → sync app files into the volume, overwriting;
#                               volume STATE survives (webpi.db, .pi-agent/,
#                               apps/, anything not in the image)
#
# Dev mode bind-mounts the host repo over /app (a git checkout) — the git
# branch covers it: no seeding, no sync.
#
# NB the sync re-pins pi to the image's lockfile (node_modules is synced
# too). In-place pi updates (`npm install …@latest` on the volume) are
# re-applied after an image sync — by design: an app release states the pi
# it was tested against.
set -e

IMAGE=/opt/web-pi

# Content hash of the image's source tree — everything except generated
# output (dist*/node_modules move when source/deps move, so hashing their
# drivers is sufficient and fast).
stamp() {
  (cd "$1" && find . \( -name node_modules -o -name dist -o -name dist-server \) -prune -o -type f -print0 \
    | sort -z | xargs -0 -r sha256sum | sha256sum | cut -c1-16)
}

if [ -f /app/package.json ] && [ -d /app/.git ]; then
  echo "web-pi: /app is a git checkout — operator-owned, image sync skipped"
elif [ ! -f /app/package.json ] || [ "$(stamp $IMAGE)" != "$(cat /app/.image-stamp 2>/dev/null || true)" ]; then
  if [ ! -f /app/package.json ]; then
    echo "web-pi: first boot — seeding /app from the image copy"
  else
    echo "web-pi: image content changed — syncing app files (state preserved)"
  fi
  # Copy every top-level entry (dotfiles included); rm first so files the
  # image dropped disappear too. Volume-only paths are never named here.
  for p in $IMAGE/* $IMAGE/.[!.]* $IMAGE/..?*; do
    [ -e "$p" ] || continue
    name="${p#$IMAGE/}"
    rm -rf "/app/$name"
    cp -a "$p" "/app/$name"
  done
  stamp $IMAGE > /app/.image-stamp
fi

cd /app
exec "$@"
