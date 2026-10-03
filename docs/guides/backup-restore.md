# Backup and Restore Guide

This guide covers backup strategies, procedures, and disaster recovery for the rfmedia-apps Docker
infrastructure.

## Overview

The platform manages multiple types of data that require different backup strategies:

| Data Type                 | Location                          | Backup Priority | Notes                                       |
| ------------------------- | --------------------------------- | --------------- | ------------------------------------------- |
| Application Configuration | `${DOCKER_DIR}/[service]`         | Critical        | Service settings, API keys, preferences     |
| Database Data             | `${DOCKER_DATA_DIR}/[service-db]` | Critical        | PostgreSQL, MariaDB, Redis data             |
| Media Files               | `${DATA_DIR}/media`               | Important       | Photos, videos, media library               |
| SSL Certificates          | `${DOCKER_DIR}/traefik/acme`      | Important       | Let's Encrypt certificates                  |
| Tailscale Sidecar State   | `${DOCKER_DIR}/`, etc.            | Moderate        | Can be regenerated with auth key            |
| Docktail / Host Tailscale | Host `tailscaled` state           | Moderate        | OAuth + host daemon; not in `${DOCKER_DIR}` |
| Docker Volumes            | Named volumes                     | Varies          | Application-specific persistent data        |

## Backup Strategy

### What Needs to Be Backed Up

**Critical (Database Services)**:

| Service   | Database Type               | Data Location                         |
| --------- | --------------------------- | ------------------------------------- |
| Authentik | PostgreSQL 16               | `${DOCKER_DATA_DIR}/authentik-db`     |
| Authentik | Redis                       | `${DOCKER_DATA_DIR}/authentik-redis`  |
| Immich    | PostgreSQL 14 (vectorchord) | `${DOCKER_DATA_DIR}/immich-postgres`  |
| Immich    | Valkey (Redis)              | Named volume (immich-redis)           |
| Forgejo   | PostgreSQL 16               | `${DOCKER_DATA_DIR}/forgejo-postgres` |

**Important (Application Configuration)**:

- Arr Stack: Sonarr, Radarr, Bazarr, Prowlarr (`${DOCKER_DIR}/[service]`)
- Media: Plex, Tautulli, Plexseerr, Jellyseerr, Kometa (`${DOCKER_DIR}/[service]`)
- Infrastructure: Traefik, Homarr, Uptime Kuma, Forgejo (`${DOCKER_DIR}/[service]`)
- Downloads: SABnzbd, Autobrr, Notifiarr (`${DOCKER_DIR}/[service]`)

**Media and User Data**:

- Immich photos/videos: `${DOCKER_DIR}/immich` (uploads)
- Forgejo repositories and attachments: `${DOCKER_DIR}/forgejo`
- Plex media: `${DATA_DIR}/media`
- Authentik media (`/data`): `${DOCKER_DIR}/authentik-server/data`

## Native and Legacy Backup Systems

The current CLI provides an on-demand cold filesystem backup and an offline verifier. It does not
provide the deprecated `manage.sh` automatic-before-stop behavior, scheduling, retention, remote
upload, encryption, signing, or automated restore.

### Native rfapps Filesystem Backup

Use native backup for eligible directory bind mounts and stable named volumes declared by the
resolved Compose project:

```bash
# Resolve the complete source and writer plan without persistent mutation
rfapps backup -g media-stack --destination /mnt/backups --dry-run

# Create a private manifest-last bundle after one confirmation
rfapps backup -g media-stack --destination /mnt/backups

# Explicit full-project, non-interactive creation
rfapps backup --all --destination /mnt/backups --yes

# Verify compressed byte counts and SHA-256 checksums without config or Docker
rfapps backup verify /mnt/backups/rfapps-backup-rfmedia-apps-20260729T120000Z/manifest.json
```

Creation is cold and filesystem-level. The requested scope selects sources, but writer detection
uses the full resolved Compose project, including writable equal, ancestor, and descendant bind
mounts. rfapps stops detected running writers, refuses to archive until they are stopped, then
restarts the exact captured container IDs. The published `rfapps-backup.v1` manifest records all
consumers, skipped sources, compressed sizes, SHA-256 checksums, and structured manual restore
hints.

`--dry-run` creates no bundle, pulls no helper image, acquires no lock, stops no service, and
archives nothing. When the digest-pinned helper is already cached, it may create only a sandboxed
read-only source-probe container, which is strictly awaited and removed. An absent helper makes the
dry-run fail closed without pulling.

Native backup does not provide transaction-aware database snapshots. Keep the
[database-native procedures](#database-backup-procedures) below for PostgreSQL, Redis/Valkey,
SQLite, and application-specific consistency needs. See
[rfapps Native Backup](../features/rfapps-backup.md) for the complete selection, safety, manifest,
verification, output, exit-code, and manual-restore contracts.

### BACKUP_ON_STOP Configuration (Legacy - Not Available)

The following section documents the deprecated `manage.sh` backup functionality for historical
reference only. These automatic-before-stop settings are **not available** in the `rfapps` CLI.

**Configuration Options**:

| Variable                | Default     | Description                                |
| ----------------------- | ----------- | ------------------------------------------ |
| `BACKUP_ON_STOP`        | `false`     | Create backups before stopping services    |
| `BACKUP_DIR`            | `./backups` | Directory for backup storage               |
| `BACKUP_RETENTION_DAYS` | `7`         | Days to keep backups (0 = disable cleanup) |
| `BACKUP_COMPRESSION`    | `true`      | Compress backups with gzip                 |

### Automatic Backups (Legacy - Not Available)

> **WARNING:** The following commands use the deprecated `manage.sh` script and **will not work**
> with the current `rfapps` CLI. They are documented for historical reference only.

<details>
<summary>Legacy manage.sh backup commands (click to expand)</summary>

**Method 1: Environment Variable**

```bash
# Enable for a single command (DEPRECATED)
BACKUP_ON_STOP=true ./manage.sh delete --yes

# Or export for session (DEPRECATED)
export BACKUP_ON_STOP=true
export BACKUP_DIR=/mnt/backups/docker
./manage.sh delete --yes
```

**Method 2: Configuration File**

Create `scripts/.env` with backup settings (DEPRECATED):

```bash
BACKUP_ON_STOP=true
BACKUP_DIR=/mnt/backups/docker
BACKUP_RETENTION_DAYS=14
BACKUP_COMPRESSION=true
```

**Command-Line Backup Options (DEPRECATED)**

```bash
# Force backup regardless of BACKUP_ON_STOP setting
./manage.sh delete --backup --yes

# Skip backup even if BACKUP_ON_STOP=true
./manage.sh delete --skip-backup --yes

# Dry run to preview backup behavior
./manage.sh delete --backup --dry-run
```

</details>

### Modern Backup Approach with rfapps CLI

Create and verify a native filesystem bundle before a destructive operation. Add database-native
dumps when the service requires application-level consistency:

```bash
# Step 1: Review the filesystem backup plan
rfapps backup -s [service_name] --destination /mnt/backups --dry-run

# Step 2: Create the bundle
rfapps backup -s [service_name] --destination /mnt/backups --yes

# Step 3: Verify the published manifest offline
rfapps backup verify /mnt/backups/<bundle>/manifest.json

# Step 4: Perform the destructive operation
rfapps delete -s [service_name] --yes

# Or for rebuilding
rfapps rebuild -s [service_name] --yes
```

### How Volume Backup Worked (Legacy - Not Available)

> **Note:** This describes the deprecated `manage.sh` backup system behavior for historical
> reference.

When triggered, the legacy backup system:

1. Creates a timestamped directory: `${BACKUP_DIR}/volumes-backup-YYYYMMDD-HHMMSS/`
2. Identifies all Docker volumes used by the compose project
3. Creates tar archives of each volume using an Alpine container
4. Optionally compresses archives with gzip (default: enabled)
5. Reports success/failure for each volume

**Backup Output Structure**:

```
${BACKUP_DIR}/
  volumes-backup-20251221-143022/
    volume-name-1.tar.gz
    volume-name-2.tar.gz
    ...
```

## Manual Backup Procedures

### Application Configuration Backup

Back up all application configuration directories:

```bash
# Create timestamped backup
BACKUP_DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_TARGET="/mnt/backups/docker-config-${BACKUP_DATE}"

# Stop services first (recommended for consistency)
rfapps stop --yes

# Backup configuration directory
sudo tar czf "${BACKUP_TARGET}.tar.gz" -C "${DOCKER_DIR}" .

# Or backup specific services
sudo tar czf "${BACKUP_TARGET}-arr.tar.gz" -C "${DOCKER_DIR}" \
    sonarr radarr bazarr prowlarr

# Restart services
rfapps deploy --yes
```

### Database Backup Procedures

#### PostgreSQL Databases (Authentik, Immich, Forgejo)

**Authentik Database**:

```bash
# Create backup while container is running
docker exec authentik-db pg_dump -U authentik authentik > authentik-backup-$(date +%Y%m%d).sql

# Compressed backup
docker exec authentik-db pg_dump -U authentik authentik | gzip > authentik-backup-$(date +%Y%m%d).sql.gz

# Custom format (supports parallel restore)
docker exec authentik-db pg_dump -U authentik -Fc authentik > authentik-backup-$(date +%Y%m%d).dump
```

**Immich Database** (includes vector extensions):

```bash
# Full database backup with extensions
docker exec immich-postgres pg_dump -U immich immich > immich-backup-$(date +%Y%m%d).sql

# Include schema for vector extensions
docker exec immich-postgres pg_dumpall -U immich --schema-only > immich-schema-$(date +%Y%m%d).sql
```

**Forgejo Database**:

```bash
# Create backup while container is running
docker exec forgejo-postgres pg_dump -U forgejo forgejo > forgejo-backup-$(date +%Y%m%d).sql

# Compressed backup
docker exec forgejo-postgres pg_dump -U forgejo forgejo | gzip > forgejo-backup-$(date +%Y%m%d).sql.gz

# Custom format (recommended for pg_restore)
docker exec forgejo-postgres pg_dump -U forgejo -Fc forgejo > forgejo-backup-$(date +%Y%m%d).dump
```

**Backup All PostgreSQL Databases Script**:

```bash
#!/bin/bash
BACKUP_DIR="/mnt/backups/databases"
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p "${BACKUP_DIR}"

# Authentik
echo "Backing up Authentik database..."
docker exec authentik-db pg_dump -U authentik -Fc authentik > "${BACKUP_DIR}/authentik-${DATE}.dump"

# Immich
echo "Backing up Immich database..."
docker exec immich-postgres pg_dump -U immich -Fc immich > "${BACKUP_DIR}/immich-${DATE}.dump"

# Forgejo
echo "Backing up Forgejo database..."
docker exec forgejo-postgres pg_dump -U forgejo -Fc forgejo > "${BACKUP_DIR}/forgejo-${DATE}.dump"

echo "Database backups complete: ${BACKUP_DIR}"
ls -la "${BACKUP_DIR}"/*-${DATE}.dump
```

#### Redis Data

Redis data is typically transient cache but some services persist data:

**Authentik Redis**:

```bash
# Trigger RDB save
docker exec authentik-redis redis-cli BGSAVE

# Wait for save to complete
docker exec authentik-redis redis-cli LASTSAVE

# Copy RDB file
docker cp authentik-redis:/data/dump.rdb ./authentik-redis-backup-$(date +%Y%m%d).rdb
```

**Immich Redis (Valkey)**:

```bash
docker exec immich-redis redis-cli BGSAVE
docker cp immich-redis:/data/dump.rdb ./immich-redis-backup-$(date +%Y%m%d).rdb
```

### Plex Database Backup

Plex stores its database in the config directory:

```bash
# Stop Plex first for consistent backup
rfapps stop -s plex --yes

# Backup Plex Preferences and database
PLEX_CONFIG="${PLEX_DOCKER_DIR}/plex"
tar czf plex-backup-$(date +%Y%m%d).tar.gz \
    -C "${PLEX_CONFIG}" \
    "Library/Application Support/Plex Media Server/Preferences.xml" \
    "Library/Application Support/Plex Media Server/Plug-in Support/Databases"

# Restart Plex
rfapps deploy -s plex --yes
```

### Immich Photos Backup

```bash
# Backup uploaded photos/videos
tar czf immich-uploads-$(date +%Y%m%d).tar.gz -C "${DOCKER_DIR}/immich" .

# Or use rsync for incremental backups
rsync -avz --progress "${DOCKER_DIR}/immich/" /mnt/backups/immich-uploads/
```

### Forgejo Data Backup

Forgejo stores repositories, attachments, and application data under `${DOCKER_DIR}/forgejo`. Back
up both this directory and the PostgreSQL database.

```bash
# Backup Forgejo application data (repositories, attachments, config)
tar czf forgejo-data-$(date +%Y%m%d).tar.gz -C "${DOCKER_DIR}/forgejo" .

# Or use rsync for incremental backups
rsync -avz --progress "${DOCKER_DIR}/forgejo/" /mnt/backups/forgejo-data/
```

### SSL Certificates Backup

```bash
# Backup Let's Encrypt certificates
tar czf letsencrypt-backup-$(date +%Y%m%d).tar.gz \
    -C "${DOCKER_DIR}" \
    traefik/acme \
    letsencrypt
```

## Restore Procedures

### Restore from a Native rfapps Bundle

rfapps records restore hints but does not execute them. Verify first, then inspect the manifest:

```bash
rfapps backup verify /mnt/backups/<bundle>/manifest.json
jq '.scope.quiescedServices, .mounts[] | {artifactPath, consumers, restore}' \
  /mnt/backups/<bundle>/manifest.json
```

For each mount:

1. stop every service that can write the destination;
2. preserve or relocate its current contents;
3. stage and inspect the declared archive, then copy approved content into the `bind-tar`
   destination path or Docker volume named by the `volume-tar` hint;
4. restore any application-native database dump required by the service;
5. restart the services and validate the application.

Never extract a bundle of untrusted provenance directly into a live destination or with a
privileged tar process. Verification checks bytes, not authenticity or archive-entry safety. For a
local bind archive, use a new private staging directory as an unprivileged account:

```bash
tar -tvzf /mnt/backups/<bundle>/artifacts/mount-0001.tar.gz
staging_dir=$(mktemp -d)
chmod 700 "${staging_dir}"
tar -xzf /mnt/backups/<bundle>/artifacts/mount-0001.tar.gz \
  --no-same-owner \
  --no-same-permissions \
  -C "${staging_dir}"
find "${staging_dir}" -xdev \( -type l -o -links +1 -o \( ! -type f -a ! -type d \) \) -print
```

Reject absolute or traversal paths, anything escaping staging, symbolic or hard links, and all
entries other than regular files and directories. Inspect ownership, modes, and application
contents. Only after independently trusting provenance should an administrator copy approved
content into the stopped destination with service-appropriate ownership and permissions, then
remove staging.

Named-volume restores require a helper with the volume mounted writable and the archive mounted
read-only. Remote-daemon restores require authority-specific transfer or mount handling; a path on
the rfapps client is not necessarily visible to that daemon. See
[Manual Restore](../features/rfapps-backup.md#manual-restore) for the complete safety checklist.

### Restore from Volume Backup

```bash
# List available backups
ls -la ${BACKUP_DIR:-./backups}/

# Restore specific volume from backup
docker volume create [volume_name]
docker run --rm \
    -v [volume_name]:/volume \
    -v ${BACKUP_DIR}/volumes-backup-YYYYMMDD-HHMMSS:/backup \
    alpine \
    sh -c "cd /volume && tar xzf /backup/[volume_name].tar.gz"

# Restart the service
rfapps deploy -s [service_name] --yes
```

### Restore PostgreSQL Database

**Authentik**:

```bash
# Stop Authentik services
rfapps stop --services authentik-server,authentik-worker --yes

# Drop and recreate database
docker exec -i authentik-db psql -U authentik -c "DROP DATABASE IF EXISTS authentik;"
docker exec -i authentik-db psql -U authentik -c "CREATE DATABASE authentik;"

# Restore from SQL backup
docker exec -i authentik-db psql -U authentik authentik < authentik-backup.sql

# Or restore from custom format
docker exec -i authentik-db pg_restore -U authentik -d authentik < authentik-backup.dump

# Restart services
rfapps deploy --services authentik-server,authentik-worker,authentik-media --yes
```

**Immich**:

```bash
# Stop Immich
rfapps stop --services immich-server,immich-ml --yes

# Restore database (includes vector extension data)
docker exec -i immich-postgres psql -U immich -c "DROP DATABASE IF EXISTS immich;"
docker exec -i immich-postgres psql -U immich -c "CREATE DATABASE immich;"
docker exec -i immich-postgres psql -U immich immich < immich-backup.sql

# Restart Immich
rfapps deploy --services immich-server,immich-ml --yes
```

**Forgejo**:

```bash
# Stop Forgejo
rfapps stop -s forgejo --yes

# Restore database
docker exec -i forgejo-postgres psql -U forgejo -c "DROP DATABASE IF EXISTS forgejo;"
docker exec -i forgejo-postgres psql -U forgejo -c "CREATE DATABASE forgejo;"
docker exec -i forgejo-postgres psql -U forgejo forgejo < forgejo-backup.sql

# Or restore from custom format
docker exec -i forgejo-postgres pg_restore -U forgejo -d forgejo < forgejo-backup.dump

# Restore application data if needed
tar xzf forgejo-data-backup.tar.gz -C "${DOCKER_DIR}/forgejo"

# Restart Forgejo
rfapps deploy -s forgejo --yes
```

### Restore Redis Data

```bash
# Stop the service using Redis
rfapps stop -s authentik-redis --yes

# Copy RDB file to container
docker cp authentik-redis-backup.rdb authentik-redis:/data/dump.rdb

# Restart Redis
rfapps deploy -s authentik-redis --yes
```

### Restore Application Configuration

```bash
# Stop all services
rfapps stop --yes

# Restore configuration
sudo tar xzf docker-config-backup.tar.gz -C "${DOCKER_DIR}"

# Fix permissions
sudo chown -R ${PUID}:${PGID} "${DOCKER_DIR}"

# Restart services
rfapps deploy --yes
```

### Disaster Recovery

Complete system restoration procedure:

```bash
# 1. Ensure Docker is running
sudo systemctl start docker

# 2. Clone the repository
git clone https://github.com/yandy-r/rfmedia-apps.git
cd rfmedia-apps

# 3. Restore environment file
cp /mnt/backups/env-backup/.env.local .
chmod 600 .env.local

# 4. Create required directories
mkdir -p ${DOCKER_DIR} ${DOCKER_DATA_DIR} ${DATA_DIR}

# 5. Restore configuration from backup
sudo tar xzf /mnt/backups/docker-config-backup.tar.gz -C ${DOCKER_DIR}

# 6. Restore database directories (for bind-mount databases)
sudo tar xzf /mnt/backups/docker-data-backup.tar.gz -C ${DOCKER_DATA_DIR}

# 7. Fix permissions
sudo chown -R ${PUID}:${PGID} ${DOCKER_DIR} ${DOCKER_DATA_DIR}

# 8. Start core infrastructure first
rfapps deploy --profile core --yes

# 9. Wait for databases to be healthy
rfapps status --health

# 10. Start remaining services
rfapps deploy --profile all --yes
```

## Backup Scheduling

### Cron-Based Backup Script

Create `/usr/local/bin/backup-docker-apps.sh`:

```bash
#!/bin/bash
set -euo pipefail

# Configuration
BACKUP_BASE="/mnt/backups/docker"
RETENTION_DAYS=30
DOCKER_DIR="${DOCKER_DIR:-/home/user/docker}"
DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${BACKUP_BASE}/${DATE}"

# Create backup directory
mkdir -p "${BACKUP_DIR}"

# Log function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

log "Starting backup to ${BACKUP_DIR}"

# Backup databases
log "Backing up PostgreSQL databases..."
docker exec authentik-db pg_dump -U authentik -Fc authentik > "${BACKUP_DIR}/authentik-db.dump" 2>/dev/null || log "WARN: authentik-db backup failed"
docker exec immich-postgres pg_dump -U immich -Fc immich > "${BACKUP_DIR}/immich-db.dump" 2>/dev/null || log "WARN: immich-db backup failed"
docker exec forgejo-postgres pg_dump -U forgejo -Fc forgejo > "${BACKUP_DIR}/forgejo-db.dump" 2>/dev/null || log "WARN: forgejo-db backup failed"

# Backup Redis
log "Backing up Redis data..."
docker exec authentik-redis redis-cli BGSAVE 2>/dev/null || true
sleep 5
docker cp authentik-redis:/data/dump.rdb "${BACKUP_DIR}/authentik-redis.rdb" 2>/dev/null || log "WARN: authentik-redis backup failed"

# Backup configuration directories (excluding large cache files)
log "Backing up configuration..."
tar czf "${BACKUP_DIR}/config.tar.gz" \
    --exclude='*/cache/*' \
    --exclude='*/logs/*' \
    --exclude='*/.cache/*' \
    --exclude='*/Transcode/*' \
    -C "${DOCKER_DIR}" . 2>/dev/null || log "WARN: config backup failed"

# Cleanup old backups
log "Cleaning up backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_BASE}" -mindepth 1 -maxdepth 1 -type d -mtime +${RETENTION_DAYS} -exec rm -rf {} \;

# Calculate backup size
BACKUP_SIZE=$(du -sh "${BACKUP_DIR}" | cut -f1)
log "Backup complete: ${BACKUP_DIR} (${BACKUP_SIZE})"
```

Make executable and add to cron:

```bash
chmod +x /usr/local/bin/backup-docker-apps.sh

# Add to crontab (daily at 3 AM)
crontab -e
# Add line:
0 3 * * * /usr/local/bin/backup-docker-apps.sh >> /var/log/docker-backup.log 2>&1
```

### Systemd Timer (Alternative)

Create `/etc/systemd/system/docker-backup.service`:

```ini
[Unit]
Description=Docker Apps Backup
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/backup-docker-apps.sh
User=root
```

Create `/etc/systemd/system/docker-backup.timer`:

```ini
[Unit]
Description=Daily Docker Apps Backup

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now docker-backup.timer
```

## Best Practices

### Backup Frequency Recommendations

| Data Type            | Frequency     | Method                     |
| -------------------- | ------------- | -------------------------- |
| PostgreSQL databases | Daily         | pg_dump to remote storage  |
| Application config   | Daily         | `rfapps backup` or tar     |
| Plex database        | Weekly        | tar archive (when stopped) |
| SSL certificates     | After renewal | Copy to secure location    |
| Media files          | Continuous    | rsync to NAS/cloud         |
| Full system          | Weekly        | Complete tar archive       |

### Backup Verification

Regularly test your backups:

```bash
# Verify a native rfapps bundle without Docker
rfapps backup verify /mnt/backups/<bundle>/manifest.json

# Test database restore to temporary container
docker run --rm -d --name test-restore -e POSTGRES_PASSWORD=test postgres:16-alpine
sleep 10
docker exec -i test-restore psql -U postgres < backup.sql
docker stop test-restore

# Verify tar archive integrity
tar tzf backup.tar.gz > /dev/null && echo "Archive OK" || echo "Archive CORRUPT"
```

### Security Considerations

1. **Encrypt sensitive backups**:

   ```bash
   tar czf - ${DOCKER_DIR} | gpg --symmetric --cipher-algo AES256 > backup.tar.gz.gpg
   ```

2. **Store backups off-site**: Use cloud storage, NAS, or remote server

3. **Protect database credentials**: Never include plain-text `.env` files in backups without
   encryption

4. **Regular restore tests**: Periodically verify backups can be restored successfully

### Storage Recommendations

- Keep at least 7 days of daily backups
- Keep at least 4 weekly backups
- Keep at least 3 monthly backups
- Store critical backups in multiple locations (3-2-1 rule):
  - 3 copies of data
  - 2 different storage types
  - 1 off-site location

## Related Documentation

- [rfapps Native Backup](../features/rfapps-backup.md) - Cold filesystem backup and offline verify
- [Troubleshooting Guide](troubleshooting.md) - Recovery procedures
- [rfapps CLI Reference](../../packages/rfapps-cli/README.md) - CLI command reference
- [Environment Variables Reference](../reference/environment-variables.md) - Backup configuration
  variables
