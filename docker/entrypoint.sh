#!/bin/sh
# Starts Platen as PUID:PGID instead of root.
#
# Files written to an Unraid share by root are root-owned, and SMB users then
# cannot rename, move or delete their own photos. Unraid's convention is
# nobody:users (99:100), which is the default here; set PUID/PGID to match
# whoever owns your shares on any other system.
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"

if [ "$(id -u)" != "0" ]; then
  # Started with --user already: nothing to change, nothing we could change.
  exec "$@"
fi

if [ "$PUID" = "0" ]; then
  echo "PUID=0: running as root. Files Platen writes will be owned by root."
  exec "$@"
fi

# Hand each writable data directory to the runtime user.
#
# Earlier versions ran as root, so an existing library is full of root-owned
# folders that the new user could not write into. The recursive chown runs
# once per directory: a marker records the owner it was done for, so later
# starts cost nothing however large the library, and changing PUID/PGID
# triggers it again. The external library mount is read-only and never touched.
for dir in \
  "${LIBRARY_PATH:-/data/library}" \
  "${THUMBS_PATH:-/data/thumbs}" \
  "${UPLOAD_TMP_PATH:-/data/tmp}" \
  /data/ml-cache
do
  mkdir -p "$dir"
  marker="$dir/.platen-owner"
  if [ "$(cat "$marker" 2>/dev/null || true)" != "$PUID:$PGID" ]; then
    echo "Giving $dir to $PUID:$PGID. Once only, but slow on a large library..."
    if chown -R "$PUID:$PGID" "$dir"; then
      echo "$PUID:$PGID" > "$marker"
      chown "$PUID:$PGID" "$marker"
    else
      # A share mounted without ownership support (NFS with root_squash, say).
      # Start anyway: plain permissions may still allow writing, and the server
      # refuses to start, naming the folder, if they do not.
      echo "WARNING: could not change the owner of $dir. Platen may be unable to write there."
    fi
  fi
done

# HOME stays /root otherwise, which the runtime user cannot write.
export HOME=/tmp
exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
