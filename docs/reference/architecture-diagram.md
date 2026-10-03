# Architecture Diagrams

This document provides comprehensive visual representations of the rfmedia-apps infrastructure using
Mermaid diagrams. These diagrams illustrate service relationships, network topology, profile
membership, and data flow patterns.

## Table of Contents

1. [Architecture Diagrams](#architecture-diagrams)
   1. [Table of Contents](#table-of-contents)
   2. [1. Service Overview Diagram](#1-service-overview-diagram)
      1. [All Services by Category](#all-services-by-category)
   3. [2. Service Dependencies Diagram](#2-service-dependencies-diagram)
      1. [Database Dependencies](#database-dependencies)
      2. [Dependency Legend](#dependency-legend)
   4. [3. Network Architecture Diagram](#3-network-architecture-diagram)
      1. [Network Topology](#network-topology)
      2. [Network Architecture Notes](#network-architecture-notes)
   5. [4. Profile Membership Diagram](#4-profile-membership-diagram)
      1. [Service-to-Profile Mapping](#service-to-profile-mapping)
      2. [Profile Hierarchy](#profile-hierarchy)
   6. [5. Data Flow Diagrams](#5-data-flow-diagrams)
      1. [Request Authentication Flow](#request-authentication-flow)
      2. [Media Acquisition Flow](#media-acquisition-flow)
      3. [Photo Management Flow](#photo-management-flow)
   7. [Service Count Summary](#service-count-summary)
   8. [Quick Reference](#quick-reference)
      1. [Services with Database Dependencies](#services-with-database-dependencies)
      2. [Profile Activation Commands](#profile-activation-commands)

## 1. Service Overview Diagram

This diagram shows all 35 services organized by their functional category. Each category represents
a logical grouping of related services.

### All Services by Category

```mermaid
flowchart TB
    subgraph Infrastructure["Infrastructure & Reverse Proxy"]
        direction TB
        docktail[docktail]
        traefik[traefik]
        cloudflared[cloudflared]
    end

    subgraph Authentication["Authentication & Identity"]
        direction TB
        authentik-server[authentik-server]
        authentik-worker[authentik-worker]
        authentik-db[authentik-db]
        authentik-redis[authentik-redis]
        authentik-media[authentik-media]
    end

    subgraph Management["Management & Cloud Storage"]
        direction TB
        homarr[homarr]
        uptime-kuma[uptime-kuma]
        uptime-kuma[uptime-kuma]
        stirlingpdf[stirlingpdf]
    end

    subgraph Downloads["Download Clients"]
        direction TB
        sabnzbd[sabnzbd]
        prowlarr[prowlarr]
        unpackerr[unpackerr]
    end

    subgraph ArrStack["Media Automation - ARR Stack"]
        direction TB
        autobrr[autobrr]
        notifiarr[notifiarr]
        bazarr[bazarr]
        sonarr[sonarr]
        radarr[radarr]
    end

    subgraph MediaServers["Media Servers & Entertainment"]
        direction TB
        plex[plex]
        plex_music[plex-music]
        jellyfin[jellyfin]
        kometa[kometa]
        tautulli[tautulli]
        plexseerr[plexseerr]
        jellyseerr[jellyseerr]
    end

    subgraph Photos["Photo Management"]
        direction TB
        immich-server[immich-server]
        immich-ml[immich-ml]
        immich-redis[immich-redis]
        immich-postgres[immich-postgres]
    end

    Infrastructure --> Authentication
    Authentication --> Management
    Management --> Downloads
    Downloads --> ArrStack
    ArrStack --> MediaServers
    MediaServers --> Photos
```

The diagram above shows the logical flow of services from infrastructure through to end-user
applications. Services within each category work together to provide specific functionality.

## 2. Service Dependencies Diagram

This diagram illustrates the dependency relationships between services, including database backends.

### Database Dependencies

```mermaid
flowchart TD
    subgraph TraefikStack["Core Ingress"]
        docktail((docktail))
        traefik[traefik]
        docktail --> traefik
    end

    subgraph AuthentikStack["Authentik Stack"]
        authentik-db[(authentik-db<br/>PostgreSQL)]
        authentik-redis[(authentik-redis<br/>Redis)]
        authentik-server[authentik-server]
        authentik-worker[authentik-worker]
        authentik-media[authentik-media]

        authentik-server --> authentik-db
        authentik-server --> authentik-redis
        authentik-worker --> authentik-db
        authentik-worker --> authentik-redis
        authentik-media --> authentik-server
        authentik-media --> authentik-db
        authentik-media --> authentik-redis
    end

    subgraph UptimeKumaStack["Uptime Kuma Stack"]
        uptime-kuma[uptime-kuma]

    end

    subgraph UptimeKumaStack["Uptime Kuma Stack"]
        uptime-kuma[uptime-kuma]
    end

    subgraph HomarrStack["Homarr Stack"]
        homarr[homarr]
    end

    subgraph StirlingPDFStack["StirlingPDF Stack"]
        stirlingpdf[stirlingpdf]
    end

    subgraph ArrStackDeps["ARR Stack Dependencies"]
        autobrr[autobrr]
        notifiarr[notifiarr]
        bazarr[bazarr]
        sonarr[sonarr]
        radarr[radarr]

    end

    subgraph MediaStack["Media Stack"]
        plex[plex]
        plex_music[plex-music]
        jellyfin[jellyfin]
        kometa[kometa]
        tautulli[tautulli]
        plexseerr[plexseerr]
        jellyseerr[jellyseerr]

    end

    subgraph ImmichStack["Immich Stack"]
        immich-postgres[(immich-postgres<br/>PostgreSQL+Vector)]
        immich-redis[(immich-redis<br/>Valkey)]
        immich-server[immich-server]
        immich-ml[immich-ml]

        immich-server --> immich-ml
        immich-server --> immich-postgres
        immich-server --> immich-redis
    end
```

### Dependency Legend

| Symbol     | Meaning                                       |
| ---------- | --------------------------------------------- |
| `((name))` | Tailnet ingress service (e.g. docktail)       |
| `[(name)]` | Database service (PostgreSQL, MariaDB, Redis) |
| `[name]`   | Application service                           |
| `-->`      | Depends on / requires                         |

## 3. Network Architecture Diagram

This diagram shows how network traffic flows through the infrastructure, including external access
patterns and internal communication.

### Network Topology

```mermaid
flowchart TB
    subgraph External["External Access"]
        Internet((Internet))
        TailscaleNet((Tailscale<br/>Network))
    end

    subgraph TraefikLayer["Traefik Routing Layer"]
        direction LR
        cloudflared[cloudflared]
        docktail[docktail<br/>Tailnet Ingress]
        traefik[Traefik<br/>Reverse Proxy]
        docktail --> traefik
        cloudflared --> traefik
    end

    subgraph AuthentikLayer["Authentication Layer"]
        direction LR
        authentik[Authentik Server]
    end

    subgraph AppsNetwork["apps Bridge Network"]
        direction TB

        subgraph InfraServices["Infrastructure Services"]
        end

        subgraph DownloadServices["Download Services"]
        end

        subgraph ArrServices["ARR Services"]
        end

        subgraph MediaServices["Media Services"]
        end

        subgraph PhotoServices["Photo Services"]
        end
    end

    Internet --> cloudflared
    TailscaleNet --> docktail

    TraefikLayer --> AuthentikLayer
    TraefikLayer --> AppsNetwork
    AuthentikLayer --> AppsNetwork
```

### Network Architecture Notes

**External Access Paths:**

1. **Public Internet via Cloudflare Tunnel**: `cloudflared` forwards to Traefik on `apps`
2. **Tailnet via Docktail**: Docktail advertises Traefik, Jellyfin, Immich (`images`), and other labeled services
3. **Tailnet via tsdproxy**: Shareable hosts `git` (Forgejo), `plex`, and `plex-music`

**Internal Communication:**

- All application services communicate via the `apps` bridge network with explicit hostnames

**Authentication Middleware:**

- `authentik-dev@docker`: Forward authentication for infrastructure services (DOMAIN)
- `authentik-media@docker`: Forward authentication for media services (DOMAIN2)

## 4. Profile Membership Diagram

This diagram shows which services belong to which Docker Compose profiles.

### Service-to-Profile Mapping

```mermaid
flowchart TB
    subgraph CoreProfile["core (9 services)"]
        direction LR
        core_docktail[docktail]
        core_traefik[traefik]
        core_cloudflared[cloudflared]
        core_authentik_server[authentik-server]
        core_authentik_worker[authentik-worker]
        core_authentik_db[authentik-db]
        core_authentik_redis[authentik-redis]
    end

    subgraph InfraProfile["infrastructure (4 services)"]
        direction LR
        infra_includes[Includes all core services]
        infra_uptime-kuma[uptime-kuma]
        infra_stirlingpdf[stirlingpdf]
        infra_homarr[homarr]
    end

    subgraph DownloadsProfile["downloads (6 services)"]
        direction LR
        dl_sabnzbd[sabnzbd]
        dl_prowlarr[prowlarr]
        dl_unpackerr[unpackerr]
    end

    subgraph ArrProfile["arr-stack (7 services)"]
        direction LR
        arr_autobrr[autobrr]
        arr_notifiarr[notifiarr]
        arr_bazarr[bazarr]
        arr_sonarr[sonarr]
        arr_radarr[radarr]
        arr_unpackerr[unpackerr]
    end

    subgraph MediaProfile["media profile (subset)"]
        direction LR
        media_plex[plex]
        media_plex_music[plex-music]
        media_kometa[kometa]
        media_tautulli[tautulli]
        media_plexseerr[plexseerr]
        media_jellyseerr[jellyseerr]
        media_homarr[homarr]
    end

    subgraph PhotosProfile["photos (4 services)"]
        direction LR
        photos_immich_server[immich-server]
        photos_immich_ml[immich-ml]
        photos_immich_postgres[immich-postgres]
        photos_immich_redis[immich-redis]
    end

    subgraph AllProfile["all (35 services)"]
        direction TB
        all_note[Contains ALL services from<br/>all profiles combined]
    end

    CoreProfile --> InfraProfile
    InfraProfile --> AllProfile
    DownloadsProfile --> AllProfile
    ArrProfile --> AllProfile
    MediaProfile --> AllProfile
    PhotosProfile --> AllProfile
```

### Profile Hierarchy

```mermaid
flowchart LR
    all[all<br/>35 services]

    core[core<br/>9 services]
    infrastructure[infrastructure<br/>4 services]
    downloads[downloads<br/>6 services]
    arr[arr-stack<br/>7 services]
    media[media<br/>4 services]
    photos[photos<br/>4 services]

    all --> core
    all --> infrastructure
    all --> downloads
    all --> arr
    all --> media
    all --> photos

    infrastructure -.-> core
```

The `infrastructure` profile includes all services from `core` plus additional management services.
The `all` profile is the union of all other profiles.

## 5. Data Flow Diagrams

These diagrams illustrate how data flows through the system for common operations.

### Request Authentication Flow

```mermaid
sequenceDiagram
    participant User
    participant Traefik
    participant Authentik
    participant Service

    User->>Traefik: HTTPS Request
    Traefik->>Traefik: Check route rules
    Traefik->>Authentik: Forward Auth Check
    alt User authenticated
        Authentik->>Traefik: 200 OK + Headers
        Traefik->>Service: Proxy Request
        Service->>Traefik: Response
        Traefik->>User: Response
    else User not authenticated
        Authentik->>User: 302 Redirect to Login
        User->>Authentik: Login credentials
        Authentik->>Authentik: Validate credentials
        Authentik->>User: 302 Redirect to original URL
        User->>Traefik: HTTPS Request (with session)
        Traefik->>Authentik: Forward Auth Check
        Authentik->>Traefik: 200 OK + Headers
        Traefik->>Service: Proxy Request
        Service->>Traefik: Response
        Traefik->>User: Response
    end
```

### Media Acquisition Flow

```mermaid
flowchart LR
    subgraph UserRequest["User Request"]
        User((User))
        Plexseerr[Plexseerr]
        Jellyseerr[Jellyseerr]
    end

    subgraph Indexing["Indexing"]
        Prowlarr[Prowlarr]
        Indexers[(Indexers)]
    end

    subgraph Automation["Media Automation"]
        Sonarr[Sonarr<br/>TV Shows]
        Radarr[Radarr<br/>Movies]
        Bazarr[Bazarr<br/>Subtitles]
    end

    subgraph Download["Download"]
        Autobrr[Autobrr]
        SABnzbd[SABnzbd]
        Unpackerr[Unpackerr]
    end

    subgraph Storage["Media Storage"]
        MediaDir[(Media<br/>Directory)]
    end

    subgraph Playback["Media Playback"]
        Plex[Plex]
        Tautulli[Tautulli]
        Kometa[Kometa]
    end

    User --> Plexseerr
    User --> Jellyseerr
    Plexseerr --> Sonarr
    Plexseerr --> Radarr
    Jellyseerr --> Sonarr
    Jellyseerr --> Radarr

    Prowlarr --> Indexers
    Sonarr --> Prowlarr
    Radarr --> Prowlarr

    Autobrr --> Prowlarr
    Autobrr --> SABnzbd

    Sonarr --> SABnzbd
    Radarr --> SABnzbd

    SABnzbd --> Unpackerr
    Unpackerr --> MediaDir

    Sonarr --> MediaDir
    Radarr --> MediaDir
    Bazarr --> MediaDir

    MediaDir --> Plex
    Plex --> Tautulli
    Kometa --> Plex

    Plex --> User
```

### Photo Management Flow

```mermaid
flowchart LR
    subgraph Upload["Photo Upload"]
        Mobile((Mobile<br/>Device))
        Desktop((Desktop<br/>Client))
        WebUI((Web<br/>Interface))
    end

    subgraph Processing["Immich Processing"]
        ImmichServer[Immich<br/>Server]
        ImmichML[Immich ML<br/>OpenVINO]
    end

    subgraph Storage["Data Storage"]
        PhotoDir[(Photo<br/>Directory)]
        ImmichDB[(PostgreSQL<br/>+ pgvector)]
        ImmichRedis[(Valkey<br/>Cache)]
    end

    subgraph Access["Photo Access"]
        TraefikRoute[Traefik<br/>Route]
    end

    Mobile --> ImmichServer
    Desktop --> ImmichServer
    WebUI --> ImmichServer

    ImmichServer --> ImmichML
    ImmichML --> ImmichServer

    ImmichServer --> PhotoDir
    ImmichServer --> ImmichDB
    ImmichServer --> ImmichRedis

    ImmichServer --> TailscaleTS
    ImmichServer --> TraefikRoute

    TailscaleTS --> Mobile
    TailscaleTS --> Desktop
    TraefikRoute --> WebUI
```

## Service Count Summary

| Profile        | Service Count | Description                                      |
| -------------- | ------------- | ------------------------------------------------ |
| core           | 9             | Essential infrastructure (proxy, authentication) |
| infrastructure | 15            | Core + management tools and file sharing         |
| downloads      | 6             | Download clients and indexers                    |
| arr-stack      | 12            | Media automation (Sonarr, Radarr, etc.)          |
| media          | 10            | Media servers and management                     |
| photos         | 4             | Photo management (Immich)                        |
| **all**        | **35**        | Complete deployment                              |

## Quick Reference

### Services with Database Dependencies

| Service          | Database        | Type                     |
| ---------------- | --------------- | ------------------------ |
| authentik-server | authentik-db    | PostgreSQL 16            |
| authentik-server | authentik-redis | Redis                    |
| uptime-kuma      | uptime-kuma-db  | MariaDB                  |
| immich-server    | immich-postgres | PostgreSQL 14 + pgvector |
| immich-server    | immich-redis    | Valkey                   |

### Profile Activation Commands

```bash
# Deploy specific profiles using rfapps CLI
rfapps deploy -p core --yes
rfapps deploy -p media --yes
rfapps deploy -p core -p infrastructure -p media --yes

# Deploy everything
rfapps deploy -p all --yes

# npm script shortcuts
npm run apps:deploy        # Deploy all services
npm run apps:start         # Alias for deploy

# Using rfapps directly with service groups
rfapps deploy -g media-stack --yes     # plex, sonarr, radarr, lidarr, bazarr
rfapps deploy -g arr-stack --yes       # sonarr, radarr, lidarr, bazarr, prowlarr
rfapps deploy -g auth-stack --yes      # all authentik services
```
