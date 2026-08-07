#!/bin/sh
set -eu

data_dir="${RAILWAY_VOLUME_MOUNT_PATH:-${MYNE_WORKER_DATA_DIR:-/app/runtime-data}}"
case "$data_dir" in
  /*) ;;
  *) echo "Worker data directory must be an absolute path" >&2; exit 1 ;;
esac
if [ "$data_dir" = "/" ]; then
  echo "Refusing to use the filesystem root as worker data storage" >&2
  exit 1
fi

mkdir -p "$data_dir"
chown -R node:node "$data_dir"
chmod 700 "$data_dir"
export MYNE_WORKER_DATA_DIR="$data_dir"

exec gosu node "$@"
