#!/bin/sh
# web-pi web container entrypoint — the serving half of the privilege
# split (DESIGN_REVIEW §1.1). The app serves the image's own copy at
# /opt/web-pi — root-owned, immutable to the app user (uid node): the old
# /app named-volume + first-boot-seed / image-sync loop is gone on
# purpose. Updates are an image rebuild + `up -d` (README "Updating"); the
# workspace half (tmux server + pi sessions, uid 2000) boots via
# docker-workspace-entrypoint.sh instead of this file.
#
# Dev mode (compose dev profile) bind-mounts the host repo over /app and
# overrides this entrypoint entirely.
set -e

cd /opt/web-pi
exec "$@"
