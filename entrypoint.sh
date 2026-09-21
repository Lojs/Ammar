#!/bin/sh
set -e

# The /data volume is often created by Docker owned by root on the host side.
# Fix its ownership here (while still root) before dropping to the
# unprivileged "ammar" user to actually run the app.
mkdir -p "${DATA_DIR:-/data}"
chown -R ammar:ammar "${DATA_DIR:-/data}"

exec gosu ammar "$@"
