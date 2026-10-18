#!/usr/bin/env bash
# Runs dsh web as the node user. The container is the sandbox boundary, so the
# image offers only the danger-full-access preset (see docker.patch.yml).
set -eu

PUID=${PUID:-1000}
PGID=${PGID:-1000}
groupmod -o -g "$PGID" node
usermod -o -u "$PUID" node

# First start: seed the data volume with the template home built into the image
# (a web profile that already has ds-bot installed).
if [ ! -d /data/profiles/web ]; then
  mkdir -p /data
  cp -a /opt/dsh-template/. /data/
fi
# Existing profiles and restored backups can belong to a previous PUID/PGID.
# Do not follow links into workspace shares or descend into other filesystems.
find -P /data -xdev \( ! -uid "$PUID" -o ! -gid "$PGID" \) \
  -exec chown -h node:node -- {} +

mkdir -p /workspace
# Only claim an empty /workspace; a populated share keeps its owners.
if [ -z "$(ls -A /workspace)" ]; then
  chown node:node /workspace
fi

# This dsh release accepts only 127.0.0.1 for --host, so an overlay binds all
# interfaces instead; the container's publish rule is the network boundary.
# DSH_LISTEN_PORT only matters with network_mode: host — published ports
# always map to 3080 inside.
HOST=${DSH_HOST:-0.0.0.0}
LISTEN_PORT=${DSH_LISTEN_PORT:-3080}
case "$HOST" in
  0.0.0.0|127.0.0.1) ;;
  *) echo "entrypoint: DSH_HOST must be 0.0.0.0 or 127.0.0.1 (got '$HOST')" >&2; exit 1 ;;
esac
case "$LISTEN_PORT" in
  ''|*[!0-9]*) echo "entrypoint: DSH_LISTEN_PORT must be a port number (got '$LISTEN_PORT')" >&2; exit 1 ;;
esac

# The webserver row's whole config is replaced by a patch, so its bundle values
# (compression on this dsh release) are restated literally.
cat > /tmp/listen.patch.yml <<EOF
- id: webserver
  config:
    host: $HOST
    port: $LISTEN_PORT
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
EOF

# --patch is a dsh option and must precede the app's own flags.
set -- dsh --profile web \
  --patch /opt/ds-bot/docker.patch.yml --patch /tmp/listen.patch.yml \
  --no-open "$@"

if [ -n "${DSH_TRUSTED_HOST:-}" ]; then
  old_ifs=$IFS
  IFS=','
  for trusted in $DSH_TRUSTED_HOST; do
    [ -n "$trusted" ] && set -- "$@" --trusted-host "$trusted"
  done
  IFS=$old_ifs
fi
export HOME=/home/node
cd /workspace

# dsh prints the address it listens on inside the container, but the browser
# reaches the server at the published address and the login cookie is bound to
# the authority it was issued for: opening the printed 127.0.0.1:3080 URL from
# the host does nothing, and a cookie minted for another authority does not let
# the address the user actually types through. Rewrite the printed URL to
# DSH_PUBLIC_URL so the line in `docker logs` is the one that works.
PUBLIC_URL=${DSH_PUBLIC_URL:-}
PUBLIC_URL=${PUBLIC_URL%/}
if [ -n "$PUBLIC_URL" ]; then
  replacement=$(printf '%s' "$PUBLIC_URL" | sed 's/[\\&|]/\\&/g')
  # The filter runs beside dsh and leaves dsh as PID 1, so signals and the
  # process identity the test checks are unchanged.
  exec gosu node "$@" > >(sed -u -E "s|^dsh web: http://[^ )]*[?&]token=([^ )&]+).*|dsh web: $replacement/?token=\1|") 2>&1
fi
exec gosu node "$@"
