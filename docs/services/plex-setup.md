# Plex Setup Guide

This guide covers the complete setup and configuration of Plex Media Server on the rfmedia-apps
platform, including hardware transcoding, library configuration, Tailscale remote access, and
integration with Tautulli and Plexseerr (Seerr).

## Prerequisites

Before setting up Plex, ensure you have:

- Docker and Docker Compose installed
- Plex account (free or Plex Pass)
- Tailscale account and authentication key
- Media files organized in a standard structure
- Intel integrated GPU for hardware transcoding (optional but recommended)

### Hardware Requirements

| Component | Minimum        | Recommended                |
| --------- | -------------- | -------------------------- |
| CPU       | Quad-core      | 6+ cores                   |
| RAM       | 4GB            | 8GB+                       |
| Storage   | SSD for config | NVMe for config            |
| GPU       | None           | Intel iGPU for transcoding |

### Required Environment Variables

Add these variables to your `.env.local` file:

```bash
# Plex Core Configuration
PLEX_CLAIM=claim-xxxxxxxxxxxxxxxxxxxx  # Get from plex.tv/claim
PLEX_ADVERTISE_URL=https://plex.media.yourdomain.com:443
# Second instance (plex-music) — must use a different claim token
PLEX_CLAIM_MUSIC=claim-yyyyyyyyyyyyyyyyyyyy
PLEX_ADVERTISE_URL_MUSIC=https://plex-music.media.yourdomain.com:443
PLEX_DOCKER_DIR=/path/to/fast/storage/plex  # SSD/NVMe recommended

# User/Group IDs
PUID=1000
PGID=1000

# Media Paths
DATA_DIR=/path/to/media  # Root media directory

# Domain Configuration
DOMAIN2=media.yourdomain.com

```

## Architecture Overview

Two Plex Media Server containers share the `apps` network and the same `${DATA_DIR}/media` library.
Each has its own claim token, advertised URL, config directory, and transcode directory. Public
HTTPS is Traefik (`plex.${DOMAIN2}` and `plex-music.${DOMAIN2}`). Shareable tailnet hosts are
registered by `tsdproxy-rfapps` (`plex` and `plex-music`).

```mermaid
flowchart TD
    subgraph External Access
        Client[Plex Client/App]
        Tailnet[Tailnet client]
    end

    subgraph Ingress
        Traefik[Traefik]
        Tsdproxy[tsdproxy-rfapps]
    end

    subgraph Plex Servers
        Plex[plex]
        PlexMusic[plex-music]
        GPU[Intel iGPU]
        Media[(Media Library)]
    end

    subgraph Companion Services
        Tautulli[Tautulli<br/>Analytics]
        Plexseerr[Plexseerr<br/>Requests]
        Kometa[Kometa<br/>Metadata]
    end

    Client -->|plex.${DOMAIN2}| Traefik
    Client -->|plex-music.${DOMAIN2}| Traefik
    Tailnet -->|host plex / plex-music| Tsdproxy
    Traefik --> Plex
    Traefik --> PlexMusic
    Tsdproxy --> Plex
    Tsdproxy --> PlexMusic
    Plex -->|Transcode| GPU
    PlexMusic -->|Transcode| GPU
    Plex -->|Read| Media
    PlexMusic -->|Read| Media
    Plex <-->|API| Tautulli
    Plex <-->|API| Plexseerr
    Plex <-->|API| Kometa
```

### Components

1. **plex** - Primary Plex Media Server (video libraries)
2. **plex-music** - Second Plex Media Server dedicated to music
3. **tautulli** - Plex analytics and monitoring (primary `plex` server)
4. **plexseerr** - Plex media request management (Seerr)
5. **jellyseerr** - Jellyfin media request management (Seerr; separate instance)
6. **kometa** - Automated metadata and collection management (primary `plex` server)

### Dual-instance layout

| Concern              | `plex`                              | `plex-music`                                           |
| -------------------- | ----------------------------------- | ------------------------------------------------------ |
| Hostname / container | `plex`                              | `plex-music`                                           |
| Traefik URL          | `https://plex.${DOMAIN2}`           | `https://plex-music.${DOMAIN2}`                        |
| Tailnet host         | `plex.${TS_DOMAIN}` via tsdproxy    | `plex-music.${TS_DOMAIN}` via tsdproxy                 |
| Claim token          | `PLEX_CLAIM`                        | `PLEX_CLAIM_MUSIC` (separate token from plex.tv/claim) |
| Advertise URL        | `PLEX_ADVERTISE_URL`                | `PLEX_ADVERTISE_URL_MUSIC`                             |
| Config               | `${PLEX_DOCKER_DIR}/plex`           | `${PLEX_DOCKER_DIR}/plex-music`                        |
| Transcode            | `${PLEX_DOCKER_DIR}/plex-transcode` | `${PLEX_DOCKER_DIR}/plex-music-transcode`              |
| Media                | `${DATA_DIR}/media`                 | `${DATA_DIR}/media` (shared bind)                      |
| GPU                  | `/dev/dri`                          | `/dev/dri` (shared; concurrent transcodes contend)     |

Keep libraries partitioned: add movie/TV/anime libraries only on `plex`, and music libraries only
on `plex-music`. Both containers can see the full media tree, so a duplicated library scan would
create two Plex servers claiming the same files.

Add a DNS record (or wildcard) for `plex-music.${DOMAIN2}` before the first Traefik certificate
request.

See [Tailscale Integration](../features/tailscale-integration.md) for the tsdproxy host pattern.

## Hardware Transcoding Setup

### Intel Quick Sync Video (QSV)

This platform uses Intel integrated graphics for hardware transcoding, which significantly reduces
CPU usage and power consumption.

#### Prerequisites

1. **Verify Intel GPU availability:**

   ```bash
   ls -la /dev/dri
   # Should show: card0, renderD128
   ```

2. **Check GPU driver:**

   ```bash
   # Install Intel GPU tools
   sudo apt install intel-gpu-tools

   # Verify GPU is detected
   intel_gpu_top
   ```

3. **Set permissions:**

   ```bash
   # Add your user to video and render groups
   sudo usermod -aG video,render $USER
   ```

#### Docker GPU Passthrough

The Plex container configuration includes GPU passthrough:

```yaml
plex:
  <<: *service-base
  container_name: plex
  networks:
    apps: {}
  # GPU Passthrough
  devices:
    - /dev/dri:/dev/dri
  environment:
    <<: *common-env
    PLEX_UID: ${PUID}
    PLEX_GID: ${PGID}
    DEBUG: no
    VERSION: latest
    PLEX_CLAIM_TOKEN: ${PLEX_CLAIM}
    PLEX_BETA_INSTALL: true
    PLEX_ADVERTISE_URL: ${PLEX_ADVERTISE_URL}
    # Optional: For NVIDIA GPU
    # NVIDIA_VISIBLE_DEVICES: all
    # NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
```

#### NVIDIA GPU Setup (Alternative)

If using an NVIDIA GPU instead:

1. Install NVIDIA Container Toolkit:

   ```bash
   sudo apt install nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```

2. Uncomment NVIDIA lines in compose.yml:

   ```yaml
   deploy:
     resources:
       reservations:
         devices:
           - driver: nvidia
             count: 1
             capabilities: [gpu]
   environment:
     NVIDIA_VISIBLE_DEVICES: all
     NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
   ```

## Library Configuration

### Directory Structure

Organize your media using the following structure:

```
${DATA_DIR}/
└── media/
    ├── movies/
    │   ├── Movie Name (Year)/
    │   │   ├── Movie Name (Year).mkv
    │   │   └── Movie Name (Year).srt
    │   └── ...
    ├── tv/
    │   ├── Show Name/
    │   │   ├── Season 01/
    │   │   │   ├── Show Name - S01E01 - Episode Title.mkv
    │   │   │   └── ...
    │   │   └── ...
    │   └── ...
    ├── music/
    │   ├── Artist Name/
    │   │   ├── Album Name/
    │   │   │   ├── 01 - Track Name.flac
    │   │   │   └── ...
    │   │   └── ...
    │   └── ...
    └── anime/
        ├── Anime Name/
        │   ├── Season 01/
        │   └── ...
        └── ...
```

### Adding Libraries in Plex

1. Open Plex web interface at `https://plex.${DOMAIN2}`
2. Go to **Settings** > **Manage** > **Libraries**
3. Click **Add Library**
4. For each library type:

**Movies:**

```
Type: Movies
Name: Movies
Folders: /data/media/movies
Scanner: Plex Movie
Agent: Plex Movie
```

**TV Shows:**

```
Type: TV Shows
Name: TV Shows
Folders: /data/media/tv
Scanner: Plex TV Series
Agent: Plex TV Series
```

**Anime (with special metadata):**

```
Type: TV Shows
Name: Anime
Folders: /data/media/anime
Scanner: Plex TV Series (or Absolute Series Scanner)
Agent: HAMA (HamaTV) - requires manual installation
```

**Music (on `plex-music` only):**

Open `https://plex-music.${DOMAIN2}` and add:

```
Type: Music
Name: Music
Folders: /data/media/music
Scanner: Plex Music
Agent: Plex Music
```

Do not also add that music folder on the primary `plex` server.

### Library Optimization Settings

For each library, configure:

1. **Advanced Settings:**
   - Enable video preview thumbnails: Yes (if storage permits)
   - Enable credits detection: Yes
   - Enable intro detection: Yes

2. **Scanning Settings:**
   - Run scheduled tasks at: 2:00 AM
   - Empty trash after every scan: Yes
   - Automatically delete pre-roll video: No

## Remote Access via Traefik

Plex is exposed through Traefik using your media domain.

### Plex Network Configuration

1. Go to **Settings** > **Network**
2. Configure:

   ```
   Secure connections: Required
   Custom server access URLs: https://plex.${DOMAIN2}
   Remote streams allowed per user: Unlimited
   LAN Networks: 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
   ```

Repeat on `plex-music` with `https://plex-music.${DOMAIN2}`. Tailnet clients can also use the
tsdproxy hosts `https://plex.${TS_DOMAIN}` and `https://plex-music.${TS_DOMAIN}`.

### Direct Play vs Transcoding

Configure client preferences for optimal streaming:

| Scenario                 | Recommendation               |
| ------------------------ | ---------------------------- |
| Local network            | Direct Play (no transcoding) |
| Remote (good connection) | Direct Play preferred        |
| Remote (poor connection) | Hardware transcoding         |
| Mobile data              | Limit bandwidth, transcode   |

## Tautulli Integration

Tautulli provides detailed analytics and monitoring for your Plex server.

### Connecting Tautulli to Plex

1. Access Tautulli at `https://tautulli.${DOMAIN2}`
2. Complete the setup wizard
3. Configure Plex connection:

   ```
   Plex Media Server:
   - Host: plex (Docker service name)
   - Port: 32400
   - Use SSL: Yes
   - Verify SSL: No (self-signed)

   Authentication:
   - Get Plex Token from server settings
   ```

### Useful Tautulli Features

1. **Notifications:**
   - Configure Discord/Slack webhooks
   - Set up email notifications
   - Alert on server down/new content

2. **History:**
   - Track watch history
   - Monitor concurrent streams
   - Identify bandwidth usage

3. **Statistics:**
   - Most watched content
   - User activity patterns
   - Transcoding statistics

## Seerr request management (Plexseerr and Jellyseerr)

The platform runs two [Seerr](https://github.com/seerr-team/seerr) instances: **plexseerr** for Plex
and **jellyseerr** for Jellyfin. Each has its own config under `${DOCKER_DIR}/plexseerr` and
`${DOCKER_DIR}/jellyseerr`.

### Migrate from Overseerr

If replacing a single `overseerr` container:

```bash
rfapps stop -s overseerr --yes
rfapps delete -s overseerr --yes
mkdir -p "${DOCKER_DIR}/plexseerr" "${DOCKER_DIR}/jellyseerr"
chown -R "${PUID}:${PGID}" "${DOCKER_DIR}/plexseerr" "${DOCKER_DIR}/jellyseerr"
rfapps deploy -s plexseerr,jellyseerr --yes
```

Add DNS records for `plexseerr.${DOMAIN2}` and `jellyseerr.${DOMAIN2}`. Update Homarr, Authentik,
and bookmarks that pointed at `overseerr.${DOMAIN2}`.

### Initial Plexseerr setup

1. Access Plexseerr at `https://plexseerr.${DOMAIN2}`
2. Sign in with Plex account
3. Configure Plex connection:

   ```
   Plex Settings:
   - Server: plex
   - Port: 32400
   - SSL: Enabled
   ```

4. Sync libraries from Plex

### Connect to Sonarr/Radarr

1. Go to **Settings** > **Services**
2. Add Radarr:

   ```
   Hostname: radarr (or radarr hostname)
   Port: 7878
   API Key: (from Radarr settings)
   Quality Profile: HD-1080p
   Root Folder: /data/media/movies
   ```

3. Add Sonarr:

   ```
   Hostname: sonarr (or sonarr hostname)
   Port: 8989
   API Key: (from Sonarr settings)
   Quality Profile: HD-1080p
   Root Folder: /data/media/tv
   ```

### User Management

Configure user permissions in Plexseerr:

1. Go to **Settings** > **Users**
2. Import Plex users
3. Set default permissions:
   - Request: Enable
   - Auto-approve: Admin only
   - Request limit: 10/week (non-admin)

### Initial Jellyseerr setup

1. Access Jellyseerr at `https://jellyseerr.${DOMAIN2}`
2. Complete the wizard and connect Jellyfin:

   ```
   Jellyfin Settings:
   - Server: jellyfin
   - Port: 8096
   - SSL: Enabled (via Traefik)
   ```

3. Add the same Sonarr/Radarr services as Plexseerr (Settings > Services) using Docker hostnames on
   the `apps` network.

## Performance Optimization

### Transcoder Settings

1. Go to **Settings** > **Transcoder**
2. Configure:

   ```
   Transcoder quality: Prefer higher speed encoding
   Background transcoding: Make my CPU hurt (fastest processing)
   Hardware acceleration: Intel Quick Sync Video
   Maximum simultaneous transcodes: 4-6 (based on GPU capability)
   ```

### Plex Database Optimization

The Plex database should be on fast storage:

```yaml
volumes:
  # Config on fast local storage (SSD/NVMe)
  - ${PLEX_DOCKER_DIR}/plex:/config
  # Transcode on fast local storage
  - ${PLEX_DOCKER_DIR}/plex-transcode:/transcode
  # Media can be on slower network storage
  - ${DATA_DIR}/media:/data/media
```

`plex-music` uses the same layout under `${PLEX_DOCKER_DIR}/plex-music` and
`${PLEX_DOCKER_DIR}/plex-music-transcode`. Create those directories on SSD/NVMe before the first
deploy.

### Memory and Cache Settings

1. Increase Docker container memory (if needed):

   ```yaml
   deploy:
     resources:
       limits:
         memory: 8G
   ```

2. Configure Plex cache:
   - Settings > Library > Cache location: `/config/Cache`
   - Ensure sufficient SSD space

## Deployment and Verification

### Deploy Plex Services

```bash
# Deploy entire media stack at once (recommended)
rfapps deploy -g media-stack --yes

# Or deploy both Plex instances
rfapps deploy --services plex,plex-music --yes

# Or deploy the primary Plex only
rfapps deploy -s plex --yes

# Deploy companion services
rfapps deploy -s tautulli -s plexseerr -s jellyseerr -s kometa --yes

# With secrets injection (dotenvx)
rfapps deploy -s plex --use-dotenvx .env.local --yes

# With secrets injection (1Password CLI)
rfapps deploy -s plex --use-op .env --yes

# Or using Docker Compose
docker compose up -d plex
```

### Claim Your Servers

Each Plex container needs its **own** claim token. Tokens expire quickly; generate them immediately
before rebuild.

1. Get a claim token from [plex.tv/claim](https://www.plex.tv/claim)
2. Update `PLEX_CLAIM` in your `.env.local`
3. Restart the primary server:

   ```bash
   rfapps rebuild -s plex --yes
   ```

4. Complete server setup at `https://plex.${DOMAIN2}/web`
5. Repeat with a **new** token in `PLEX_CLAIM_MUSIC`, then:

   ```bash
   rfapps rebuild -s plex-music --yes
   ```

6. Complete music-server setup at `https://plex-music.${DOMAIN2}/web`

Plex clients can see both servers on the same Plex account. Set custom access URLs to
`https://plex.${DOMAIN2}` and `https://plex-music.${DOMAIN2}` respectively.

### Verify Hardware Transcoding

1. Play a video that requires transcoding
2. Check GPU usage:

   ```bash
   # Intel GPU
   intel_gpu_top

   # Or from inside container
   docker exec plex ls -la /dev/dri
   ```

3. Verify in Plex dashboard:
   - Playing video should show "(hw)" next to transcode indicator

## Common Plex Issues

### Check Service Status

Before troubleshooting, check the service status:

```bash
# Check Plex service status
rfapps status -s plex

# Check with health details
rfapps status -s plex --health

# Check entire media stack
rfapps status -g media-stack
```

### Server Not Found

**Symptoms:** Plex apps cannot find server, "Not authorized" errors.

**Solutions:**

1. **Verify Plex claim:**

   ```bash
   docker compose logs plex | grep -i claim
   ```

2. **Check advertise URL:**

   ```bash
   # Ensure PLEX_ADVERTISE_URL matches your access URL
   echo $PLEX_ADVERTISE_URL
   ```

3. **Reset Plex preferences:**

   ```bash
   # Backup and remove preferences
   cp ${PLEX_DOCKER_DIR}/plex/Library/Application\ Support/Plex\ Media\ Server/Preferences.xml /backup/
   rm ${PLEX_DOCKER_DIR}/plex/Library/Application\ Support/Plex\ Media\ Server/Preferences.xml
   rfapps rebuild -s plex --yes
   ```

### Hardware Transcoding Not Working

**Symptoms:** High CPU usage during transcoding, "(hw)" not shown.

**Solutions:**

1. **Verify GPU passthrough:**

   ```bash
   docker exec plex ls -la /dev/dri
   # Should show: renderD128
   ```

2. **Check Plex Pass:**

   Hardware transcoding requires Plex Pass subscription.

3. **Verify driver installation:**

   ```bash
   docker exec plex vainfo
   ```

4. **Check container permissions:**

   ```bash
   # Ensure PUID/PGID have access to /dev/dri
   ls -la /dev/dri
   ```

### Remote Access Issues

**Symptoms:** Cannot connect when outside local network.

**Solutions:**

1. **Check Plex network settings:**
   - Ensure custom access URL is correct
   - Verify secure connections setting

2. **Test direct access:**

   ```bash
   curl -k https://plex.${DOMAIN2}
   ```

### Library Not Scanning

**Symptoms:** New media not appearing in Plex.

**Solutions:**

1. **Check file permissions:**

   ```bash
   docker exec plex ls -la /data/media/movies
   # Files should be owned by PUID:PGID
   ```

2. **Verify naming conventions:**
   - Movies: `Movie Name (Year)/Movie Name (Year).mkv`
   - TV: `Show Name/Season 01/Show Name - S01E01.mkv`

3. **Force library scan:**

   ```bash
   docker exec plex /usr/lib/plexmediaserver/Plex\ Media\ Scanner --scan --refresh
   ```

### Database Corruption

**Symptoms:** Plex slow or crashing, metadata issues.

**Solutions:**

1. **Optimize database:**

   ```bash
   # Stop Plex first
   docker compose stop plex

   # Optimize database
   docker exec -it plex /usr/lib/plexmediaserver/Plex\ Media\ Server --optimize-db

   # Start Plex
   docker compose start plex
   ```

2. **Repair database:**

   ```bash
   # Backup database first!
   cp "${PLEX_DOCKER_DIR}/plex/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db" /backup/

   # Repair
   docker exec plex sqlite3 "/config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db" "PRAGMA integrity_check"
   ```

## Backup and Maintenance

### Backup Strategy

```bash
#!/bin/bash
# Plex backup script
BACKUP_DIR="/backups/plex/$(date +%Y%m%d)"
mkdir -p $BACKUP_DIR

# Stop Plex for consistent backup
docker compose stop plex

# Backup database and preferences
cp -r "${PLEX_DOCKER_DIR}/plex/Library/Application Support/Plex Media Server/Plug-in Support/Databases" $BACKUP_DIR/
cp "${PLEX_DOCKER_DIR}/plex/Library/Application Support/Plex Media Server/Preferences.xml" $BACKUP_DIR/

# Start Plex
docker compose start plex
```

### Regular Maintenance

1. **Weekly:** Check for Plex updates
2. **Monthly:** Review transcoding statistics
3. **Quarterly:** Optimize database
4. **Annually:** Review library organization

## Related Documentation

- [Arr Stack Setup Guide](arr-stack-setup.md)
- [Traefik Setup Guide](traefik-setup.md)
- [Tailscale Integration](../features/tailscale-integration.md)
- [Troubleshooting Guide](../guides/troubleshooting.md)

## External References

- [Plex Support](https://support.plex.tv/)
- [Plex Hardware Transcoding](https://support.plex.tv/articles/115002178853-using-hardware-accelerated-streaming/)
- [Tautulli Wiki](https://github.com/Tautulli/Tautulli/wiki)
- [Seerr Documentation](https://docs.seerr.dev/)
