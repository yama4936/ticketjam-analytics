#!/bin/sh
set -eu
umask 077
backup_dir=${BACKUP_DIR:-/backups}
mkdir -p "$backup_dir"
backup_file="$backup_dir/ticketjam-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
trap 'rm -f "$backup_file.partial"' EXIT HUP INT TERM
pg_dump --host=db --username=ticketjam --dbname=ticketjam --format=custom --no-owner --no-acl --file="$backup_file.partial"
pg_restore --list "$backup_file.partial" >/dev/null
mv "$backup_file.partial" "$backup_file"
find "$backup_dir" -maxdepth 1 -type f -name 'ticketjam-*.dump' -mtime +14 -delete
echo "Backup completed: $(basename "$backup_file")"
