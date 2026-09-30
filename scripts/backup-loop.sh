#!/bin/sh
set -eu
while :; do
  if sh /scripts/backup-once.sh; then
    sleep 86400
  else
    echo 'Backup failed; retry in 30 minutes' >&2
    sleep 1800
  fi
done
