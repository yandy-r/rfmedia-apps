# Journalistic Research: Lidarr API Integration for Music Management CLI

## Executive Summary

Lidarr's REST API (v1) provides comprehensive music collection management through approximately 80+ endpoints covering artist, album, track, queue, command, and system operations -- all authenticated via a simple `X-Api-Key` header. The ecosystem has a notable gap in TypeScript tooling: while Python (pyarr, lidarr-py) and Go (golift/starr) have mature API clients, the only TypeScript option is the recently released TsArr SDK (v1.11.0, February 2026), which is auto-generated from OpenAPI specs. Similar artist discovery is NOT natively available in Lidarr's API -- it requires external tools (Lidify, Aurral, Tubifarry) that bridge Last.fm and MusicBrainz recommendations into Lidarr. The current stable version is 3.1.0.4875 (November 2024), with nightly builds at 3.1.2.4914.

## Current State of Lidarr API

### API Overview

- **Current stable version**: 3.1.0.4875 (released November 16, 2024)
- **Latest nightly**: 3.1.2.4914 (February 4, 2026)
- **API base path**: `/api/v1/`
- **OpenAPI spec**: `https://raw.githubusercontent.com/lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json`
- **API spec version**: 1.0.0
- **Default port**: 8686
- **Framework**: .NET 8 (migrated from .NET 6 in v3.0.1)
- **Documentation status**: Swagger UI at `https://lidarr.audio/docs/api/` renders from OpenAPI JSON; no hand-written API guide exists. The auto-generated docs are functional but lack usage examples and common patterns.
- **Documentation generator**: Swashbuckle.AspNetCore.Cli v9.0.6

**Confidence**: High -- verified from official OpenAPI spec, GitHub releases, and multiple SDK implementations.

### Authentication

Two methods supported:

1. **Header**: `X-Api-Key: <your-key>` (recommended)
2. **Query string**: `?apikey=<your-key>`
3. **Login endpoint**: `POST /login` with username/password (for UI authentication)

The API key is found in: Lidarr UI > Settings > General > Security section.

**Important change**: Basic Authentication was removed in v3.0.1.4866 (October 2024). Only API key and Forms authentication remain.

**Confidence**: High -- confirmed across official docs, SDKs, and community scripts.

### Available Endpoints

The following is a comprehensive catalog of all API v1 endpoints extracted from the official OpenAPI specification.

#### Artist Management

| Method   | Endpoint                | Description                                                                             |
| -------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/artist`        | List all artists (filter by `mbId`)                                                     |
| `POST`   | `/api/v1/artist`        | Add a new artist                                                                        |
| `GET`    | `/api/v1/artist/{id}`   | Get specific artist by internal ID                                                      |
| `PUT`    | `/api/v1/artist/{id}`   | Update an existing artist                                                               |
| `DELETE` | `/api/v1/artist/{id}`   | Delete an artist (params: `deleteFiles`, `addImportListExclusion`)                      |
| `GET`    | `/api/v1/artist/lookup` | Search for artists by term (`?term=<search>`) or MusicBrainz ID (`?term=lidarr:<mbid>`) |
| `PUT`    | `/api/v1/artist/editor` | Bulk update multiple artists                                                            |
| `DELETE` | `/api/v1/artist/editor` | Bulk delete multiple artists                                                            |

**Adding an Artist -- Required Fields**:

- `artistName` / `foreignArtistId` (from lookup)
- `qualityProfileId` (integer, from `/api/v1/qualityprofile`)
- `metadataProfileId` (integer, from `/api/v1/metadataprofile`)
- `rootFolderPath` (string, from `/api/v1/rootfolder`)
- `monitored` (boolean)
- `addOptions.monitor` (enum: `"all"`, `"future"`, `"missing"`, `"existing"`, `"first"`, `"latest"`, `"none"`)
- `addOptions.searchForMissingAlbums` (boolean)

**Confidence**: High -- verified from OpenAPI spec, pyarr docs, Go starr library, and community scripts.

#### Album Management

| Method   | Endpoint                | Description                                                       |
| -------- | ----------------------- | ----------------------------------------------------------------- |
| `GET`    | `/api/v1/album`         | List albums (filter by `artistId`, `albumIds`, `foreignAlbumId`)  |
| `POST`   | `/api/v1/album`         | Add a new album                                                   |
| `GET`    | `/api/v1/album/{id}`    | Get specific album                                                |
| `PUT`    | `/api/v1/album/{id}`    | Update an album                                                   |
| `DELETE` | `/api/v1/album/{id}`    | Delete an album (params: `deleteFiles`, `addImportListExclusion`) |
| `PUT`    | `/api/v1/album/monitor` | Bulk monitor/unmonitor albums                                     |
| `GET`    | `/api/v1/album/lookup`  | Search for albums by term                                         |

**Monitor Endpoint Body** (PUT `/api/v1/album/monitor`):

```json
{
  "albumIds": [1, 2, 3],
  "monitored": true
}
```

**Confidence**: High -- confirmed from OpenAPI spec, community shell script, and Go starr library.

#### Track & File Management

| Method   | Endpoint                 | Description                                                                   |
| -------- | ------------------------ | ----------------------------------------------------------------------------- |
| `GET`    | `/api/v1/track`          | Get tracks (filter by `artistId`, `albumId`, `albumReleaseId`, `trackIds`)    |
| `GET`    | `/api/v1/trackfile`      | Get track files (filter by `artistId`, `albumId`, `trackFileIds`, `unmapped`) |
| `PUT`    | `/api/v1/trackfile/{id}` | Update track file metadata                                                    |
| `DELETE` | `/api/v1/trackfile/{id}` | Delete a track file                                                           |
| `DELETE` | `/api/v1/trackfile/bulk` | Bulk delete track files                                                       |

**Confidence**: High -- from OpenAPI spec and Go/Python SDK mappings.

#### Search & Lookup

| Method | Endpoint                | Description                                               |
| ------ | ----------------------- | --------------------------------------------------------- |
| `GET`  | `/api/v1/artist/lookup` | Search for artists by name or MusicBrainz ID              |
| `GET`  | `/api/v1/album/lookup`  | Search for albums by name                                 |
| `GET`  | `/api/v1/parse`         | Parse a filename and return matched music data            |
| `GET`  | `/api/v1/release`       | Search indexers for releases (by `artistId` or `albumId`) |

**Confidence**: High.

#### Commands (POST /api/v1/command)

Available command names sent as `{"name": "<CommandName>", ...params}`:

| Command                     | Parameters                                                  | Description                                     |
| --------------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| `RefreshArtist`             | `artistIds: [int]` (optional)                               | Refresh artist metadata; all if no ID           |
| `AlbumSearch`               | `albumIds: [int]` or `artistIds: [int]`                     | Search for specific albums or all artist albums |
| `MissingAlbumSearch`        | `artistIds: [int]` (optional)                               | Search for all missing albums                   |
| `RenameArtist`              | `artistIds: [int]`                                          | Rename artist folders                           |
| `RetagArtist`               | `artistIds: [int]`                                          | Retag artist files                              |
| `RenameFiles`               | `artistId: int, files: [int]`                               | Rename specific files                           |
| `RetagFiles`                | `artistId: int, files: [int]`                               | Retag specific files                            |
| `ApplicationCheckUpdate`    | none                                                        | Check for application updates                   |
| `Backup`                    | none                                                        | Create a backup                                 |
| `RefreshMonitoredDownloads` | none                                                        | Refresh download queue                          |
| `ClearBlocklist`            | none                                                        | Clear the blocklist                             |
| `CleanUpRecycleBin`         | none                                                        | Clean recycle bin                               |
| `MoveArtist`                | `artistId, sourceRootFolderPath, destinationRootFolderPath` | Move artist to new root folder                  |

**Note**: The command `RescanArtist` does NOT exist despite some documentation referencing it (GitHub issue #1117 confirmed this).

**Confidence**: High -- verified from Huntarr-Lidarr scripts, pyarr docs, and GitHub issues.

#### Queue Management

| Method   | Endpoint                  | Description                                                 |
| -------- | ------------------------- | ----------------------------------------------------------- |
| `GET`    | `/api/v1/queue`           | Paginated download queue                                    |
| `GET`    | `/api/v1/queue/details`   | Queue details (filter by `artistId`, `albumIds`)            |
| `GET`    | `/api/v1/queue/status`    | Queue status summary                                        |
| `DELETE` | `/api/v1/queue/{id}`      | Remove queue item (params: `removeFromClient`, `blocklist`) |
| `DELETE` | `/api/v1/queue/bulk`      | Bulk remove queue items                                     |
| `POST`   | `/api/v1/queue/grab/{id}` | Grab a queued item                                          |
| `POST`   | `/api/v1/queue/grab/bulk` | Bulk grab queued items                                      |

**Confidence**: High.

#### Wanted/Missing

| Method | Endpoint                 | Description                             |
| ------ | ------------------------ | --------------------------------------- |
| `GET`  | `/api/v1/wanted/missing` | Albums missing from disk (paginated)    |
| `GET`  | `/api/v1/wanted/cutoff`  | Albums below quality cutoff (paginated) |

Pagination params: `page`, `pageSize`, `sortKey`, `sortDirection`, `totalRecords`.

**Warning**: The `/wanted/missing` endpoint can return hundreds of thousands of entries for large libraries (reported: 270,000+ albums across 273 pages). Large page sizes (e.g., 3000) can reduce pagination overhead but may stress the instance.

**Confidence**: High -- confirmed from Huntarr.io issues and pyarr documentation.

#### Quality & Metadata Profiles

| Method                | Endpoint                           | Description                      |
| --------------------- | ---------------------------------- | -------------------------------- |
| `GET/POST/PUT/DELETE` | `/api/v1/qualityprofile[/{id}]`    | Quality profile CRUD             |
| `GET`                 | `/api/v1/qualityprofile/schema`    | Available quality profile schema |
| `GET/PUT`             | `/api/v1/qualitydefinition[/{id}]` | Quality definitions              |
| `GET/PUT`             | `/api/v1/metadataprofile[/{id}]`   | Metadata profiles                |
| `GET/PUT`             | `/api/v1/metadataprovider`         | Metadata provider settings       |
| `GET/POST/PUT/DELETE` | `/api/v1/customformat[/{id}]`      | Custom formats (newer feature)   |

**Confidence**: High.

#### Root Folders

| Method   | Endpoint                  | Description                                |
| -------- | ------------------------- | ------------------------------------------ |
| `GET`    | `/api/v1/rootfolder`      | List all root folders with free space info |
| `POST`   | `/api/v1/rootfolder`      | Add a root folder                          |
| `DELETE` | `/api/v1/rootfolder/{id}` | Remove a root folder                       |

**Confidence**: High.

#### Import Lists

| Method                | Endpoint                             | Description                   |
| --------------------- | ------------------------------------ | ----------------------------- |
| `GET/POST/PUT/DELETE` | `/api/v1/importlist[/{id}]`          | Import list CRUD              |
| `GET`                 | `/api/v1/importlist/schema`          | Available import list schemas |
| `POST`                | `/api/v1/importlist/test`            | Test import list connection   |
| `GET/POST/DELETE`     | `/api/v1/importlistexclusion[/{id}]` | Manage import exclusions      |
| `DELETE`              | `/api/v1/importlistexclusion/bulk`   | Bulk delete exclusions        |

Supported import list sources include: Spotify (playlists, saved albums, followed artists), Last.fm (user, tag), Headphones, Lidarr (another instance), and MusicBrainz (series).

**Confidence**: High -- from OpenAPI spec and Terraform provider docs.

#### History

| Method | Endpoint                      | Description                     |
| ------ | ----------------------------- | ------------------------------- |
| `GET`  | `/api/v1/history`             | Paginated history of all events |
| `GET`  | `/api/v1/history/since`       | Events since a specific date    |
| `GET`  | `/api/v1/history/artist`      | History for a specific artist   |
| `POST` | `/api/v1/history/failed/{id}` | Mark a history item as failed   |

**Confidence**: High.

#### Tags

| Method                | Endpoint                    | Description                            |
| --------------------- | --------------------------- | -------------------------------------- |
| `GET/POST/PUT/DELETE` | `/api/v1/tag[/{id}]`        | Tag CRUD                               |
| `GET`                 | `/api/v1/tag/detail[/{id}]` | Detailed tag info (shows linked items) |

**Confidence**: High.

#### Blocklist

| Method   | Endpoint                 | Description         |
| -------- | ------------------------ | ------------------- |
| `GET`    | `/api/v1/blocklist`      | Paginated blocklist |
| `DELETE` | `/api/v1/blocklist/{id}` | Remove single entry |
| `DELETE` | `/api/v1/blocklist/bulk` | Bulk remove entries |

**Confidence**: High.

#### System & Monitoring

| Method | Endpoint                             | Description               |
| ------ | ------------------------------------ | ------------------------- |
| `GET`  | `/api/v1/health`                     | System health checks      |
| `GET`  | `/api/v1/diskspace`                  | Disk usage                |
| `GET`  | `/api/v1/system/status`              | System version, OS, paths |
| `GET`  | `/api/v1/system/backup`              | Available backups         |
| `POST` | `/api/v1/system/backup/restore/{id}` | Restore a backup          |
| `GET`  | `/api/v1/log`                        | Paginated logs            |
| `GET`  | `/api/v1/log/file`                   | Log file listing          |
| `GET`  | `/api/v1/task`                       | Scheduled tasks           |
| `GET`  | `/api/v1/update`                     | Available updates         |
| `GET`  | `/api/v1/language`                   | Available languages       |
| `GET`  | `/api/v1/localization`               | Localization data         |

**Confidence**: High.

#### Configuration

| Method    | Endpoint                                | Description               |
| --------- | --------------------------------------- | ------------------------- |
| `GET/PUT` | `/api/v1/config/host[/{id}]`            | General/host settings     |
| `GET/PUT` | `/api/v1/config/downloadclient[/{id}]`  | Download client config    |
| `GET/PUT` | `/api/v1/config/indexer[/{id}]`         | Indexer config            |
| `GET/PUT` | `/api/v1/config/naming[/{id}]`          | File/folder naming rules  |
| `GET/PUT` | `/api/v1/config/ui[/{id}]`              | UI settings               |
| `GET/PUT` | `/api/v1/config/mediamanagement[/{id}]` | Media management settings |

**Confidence**: High.

#### Calendar & Feeds

| Method | Endpoint                       | Description                                    |
| ------ | ------------------------------ | ---------------------------------------------- |
| `GET`  | `/api/v1/calendar`             | Upcoming album releases (filter by date range) |
| `GET`  | `/api/v1/calendar/{id}`        | Specific calendar entry                        |
| `GET`  | `/feed/v1/calendar/lidarr.ics` | iCalendar feed export                          |

**Confidence**: High.

#### Notifications & Download Clients

| Method                | Endpoint                         | Description                    |
| --------------------- | -------------------------------- | ------------------------------ |
| `GET/POST/PUT/DELETE` | `/api/v1/notification[/{id}]`    | Notification CRUD              |
| `GET`                 | `/api/v1/notification/schema`    | Available notification schemas |
| `POST`                | `/api/v1/notification/test`      | Test notification              |
| `GET/POST/PUT/DELETE` | `/api/v1/downloadclient[/{id}]`  | Download client CRUD           |
| `GET`                 | `/api/v1/downloadclient/schema`  | Available client schemas       |
| `POST`                | `/api/v1/downloadclient/test`    | Test client                    |
| `POST`                | `/api/v1/downloadclient/testall` | Test all clients               |
| `GET/POST/PUT/DELETE` | `/api/v1/indexer[/{id}]`         | Indexer CRUD                   |
| `GET`                 | `/api/v1/indexer/schema`         | Available indexer schemas      |
| `POST`                | `/api/v1/indexer/test`           | Test indexer                   |
| `POST`                | `/api/v1/indexer/testall`        | Test all indexers              |

**Confidence**: High.

#### Custom Filters

| Method                | Endpoint                      | Description        |
| --------------------- | ----------------------------- | ------------------ |
| `GET/POST/PUT/DELETE` | `/api/v1/customfilter[/{id}]` | Custom filter CRUD |

**Confidence**: High.

#### Manual Import & Rename/Retag

| Method | Endpoint               | Description                                        |
| ------ | ---------------------- | -------------------------------------------------- |
| `GET`  | `/api/v1/manualimport` | List files for manual import                       |
| `PUT`  | `/api/v1/manualimport` | Update manual import decisions                     |
| `GET`  | `/api/v1/rename`       | Files needing renaming (by `artistId`)             |
| `GET`  | `/api/v1/retag`        | Files needing retagging (by `artistId`, `albumId`) |

**Confidence**: High.

## Key Players and Tools

### TsArr (TypeScript)

- **Role**: Type-safe TypeScript SDK for all Servarr APIs including Lidarr
- **Language**: TypeScript (100%)
- **Package**: `tsarr` on npm, v1.11.0
- **Last update**: February 4, 2026
- **Generation**: Auto-generated from official OpenAPI specs using `@hey-api/openapi-ts`
- **Runtime**: Bun (with native fetch)
- **Activity**: Active (154 commits)
- **Source**: [https://github.com/robbeverhelst/TsArr](https://github.com/robbeverhelst/TsArr)
- **Docs**: [https://robbeverhelst.github.io/Tsarr/](https://robbeverhelst.github.io/Tsarr/)

**Confidence**: High -- verified from GitHub repo and documentation site.

### pyarr (Python)

- **Role**: Python client for all Servarr APIs (Sonarr, Radarr, Readarr, Lidarr)
- **Language**: Python
- **Activity**: Established and maintained
- **Docs**: [https://docs.totaldebug.uk/pyarr/](https://docs.totaldebug.uk/pyarr/)
- **Source**: [https://github.com/totaldebug/pyarr](https://github.com/totaldebug/pyarr)
- **Notes**: Hand-crafted wrapper with comprehensive Lidarr support. The most detailed method-level documentation available for the Lidarr API.

**Confidence**: High.

### lidarr-py (Python, auto-generated)

- **Role**: Auto-generated Python SDK specifically for Lidarr
- **Language**: Python
- **Lidarr API version**: v3.1.0.4875
- **Generator**: OpenAPI Generator v7.19.0
- **Activity**: Active (169 commits)
- **Source**: [https://github.com/devopsarr/lidarr-py](https://github.com/devopsarr/lidarr-py)
- **Notes**: Generated from the official OpenAPI spec. Part of the DevOpsArr organization which maintains auto-generated SDKs for all \*arr apps.

**Confidence**: High.

### golift/starr (Go)

- **Role**: Fully functional Go package for all Servarr APIs
- **Language**: Go
- **Activity**: Active and well-maintained
- **Coverage**: 50-100 endpoints per app
- **Source**: [https://github.com/golift/starr](https://github.com/golift/starr)
- **Docs**: [https://pkg.go.dev/github.com/craigjmidwinter/starr/lidarr](https://pkg.go.dev/github.com/craigjmidwinter/starr/lidarr)
- **Notes**: Most mature and comprehensive API client. Well-typed with context-aware variants for all methods.

**Confidence**: High.

### lidarr-go (Go, auto-generated)

- **Role**: Auto-generated Go SDK for Lidarr
- **Language**: Go
- **Source**: [https://github.com/devopsarr/lidarr-go](https://github.com/devopsarr/lidarr-go)
- **Notes**: Generated by OpenAPI Generator. Part of the DevOpsArr organization.

**Confidence**: High.

### Lidarr Rust Crate

- **Role**: Rust API client for Lidarr
- **Language**: Rust
- **Source**: [https://crates.io/crates/lidarr](https://crates.io/crates/lidarr)

**Confidence**: Medium -- found in crates.io but not deeply investigated.

### Lidify

- **Role**: Music discovery tool providing recommendations based on Lidarr library artists
- **Language**: Python (49.9%), JavaScript (27.2%)
- **Activity**: Active (514 stars, v0.2.3, February 2025)
- **Discovery engine**: Last.fm exclusively (Spotify API deprecated for this use case as of November 2024)
- **Lidarr integration**: Reads artist library, can auto-add discovered artists
- **Source**: [https://github.com/TheWicklowWolf/Lidify](https://github.com/TheWicklowWolf/Lidify)

**Confidence**: High.

### Aurral

- **Role**: Streamlined artist request manager for Lidarr
- **Language**: Node.js backend, React frontend
- **Discovery mechanism**: Samples existing Lidarr artists, queries MusicBrainz for sub-genre/tag analysis, finds similar artists by tag combination matching
- **External APIs**: MusicBrainz (primary), Last.fm (optional for imagery)
- **Rate limiting**: Respects MusicBrainz 1 req/sec limit
- **Source**: [https://github.com/lklynet/aurral](https://github.com/lklynet/aurral)
- **Notes**: Undergoing significant rebuild; new test branch with consolidated container image.

**Confidence**: Medium -- project is in active development/rebuild.

### Tubifarry

- **Role**: Lidarr plugin for fetching music from YouTube, Soulseek/Slskd, Spotify playlists
- **Language**: C# (Lidarr plugin)
- **Similar Artists feature**: Uses Last.fm recommendation data, triggered with `~` prefix in search
- **Activity**: Active (612 stars, 145 commits)
- **Source**: [https://github.com/TypNull/Tubifarry](https://github.com/TypNull/Tubifarry)

**Confidence**: High.

### Soularr

- **Role**: Connects Lidarr wanted lists with Soulseek/Slskd for downloading
- **Language**: Python
- **Uses**: pyarr for Lidarr API, slskd-api for Soulseek
- **Workflow**: Reads wanted albums from Lidarr, downloads via Slskd, triggers Lidarr import
- **Source**: [https://github.com/mrusse/soularr](https://github.com/mrusse/soularr)

**Confidence**: High.

### Buildarr

- **Role**: Configuration management for \*arr stack via YAML
- **Language**: Python
- **Lidarr support**: Via plugin system (extensible)
- **Source**: [https://buildarr.github.io/](https://buildarr.github.io/)
- **Notes**: Idempotent configuration, supports TRaSH Guides sync

**Confidence**: Medium -- Lidarr-specific plugin support not fully confirmed.

### Recyclarr

- **Role**: TRaSH Guides sync for quality profiles
- **Lidarr support**: NOT supported (Sonarr and Radarr only)
- **Source**: [https://recyclarr.dev/](https://recyclarr.dev/)

**Confidence**: High -- explicitly confirmed Lidarr is not supported.

### Notifiarr

- **Role**: Notification aggregation and monitoring
- **Lidarr support**: Yes, via built-in Lidarr connection for notifications
- **Source**: [https://notifiarr.wiki/](https://notifiarr.wiki/)

**Confidence**: High.

### Huntarr-Lidarr

- **Role**: Automated missing music searcher for Lidarr
- **Language**: Python
- **Lidarr API endpoints used**: `/api/v1/artist`, `/api/v1/album`, `/api/v1/track`, `/api/v1/qualityprofile`, `/api/v1/wanted/cutoff`, `/api/v1/command`
- **Source**: [https://github.com/plexguide/Huntarr-Lidarr](https://github.com/plexguide/Huntarr-Lidarr)

**Confidence**: High -- verified from source code analysis.

## Latest Developments

### .NET 8 Migration (v3.0.1 - v3.1.x, October-November 2024)

- **Date**: October-November 2024
- **What happened**: Lidarr migrated from .NET 6 to .NET 8, including SQLite migration to SourceGear, removal of linux-x86 support, and removal of Basic Authentication.
- **Impact**: Breaking change requiring GLIBC 2.29+. MacOS appdata folder migration. Removed Basic Auth means API key is now the only programmatic authentication method.
- **Source**: [https://github.com/lidarr/Lidarr/releases](https://github.com/lidarr/Lidarr/releases)

**Confidence**: High.

### Custom Format Support (v3.1.x, 2024)

- **Date**: Late 2024
- **What happened**: Custom format and custom format rename tokens were added, aligning Lidarr more closely with Radarr/Sonarr capabilities.
- **Source**: [https://github.com/lidarr/Lidarr/releases](https://github.com/lidarr/Lidarr/releases)

**Confidence**: High.

### Spotify API Restrictions (November 2024)

- **Date**: November 2024
- **What happened**: Changes to Spotify's API prevented third-party tools like Lidify from using it for artist discovery. Lidify migrated to Last.fm-only. Lidarr's own Spotify import lists continue to work but may face future restrictions.
- **Source**: [https://github.com/TheWicklowWolf/Lidify](https://github.com/TheWicklowWolf/Lidify)

**Confidence**: High.

### api.lidarr.audio Reliability Issues (2024-2025)

- **Date**: Ongoing through 2024-2025
- **What happened**: Lidarr's upstream metadata API (api.lidarr.audio) has experienced recurring 503 errors with "all-rate-limited: true" headers. Large libraries (75k+ tracks) are especially affected, losing artwork and metadata caching during outages. No retry/backoff logic exists in the client.
- **Impact**: MediaCover cache can be wiped and unable to repopulate during outages. Artists stop displaying available albums.
- **Source**: [https://github.com/Lidarr/Lidarr/issues/5579](https://github.com/Lidarr/Lidarr/issues/5579), [https://github.com/Lidarr/Lidarr/issues/5498](https://github.com/Lidarr/Lidarr/issues/5498)

**Confidence**: High -- multiple GitHub issues confirm.

### Search API Instability (2024-2025)

- **Date**: Ongoing
- **What happened**: Multiple reports of Lidarr search API returning 500 errors, "Internal Server Error" responses when looking up artists or MusicBrainz IDs. The external metadata dependency (api.lidarr.audio) is the bottleneck.
- **Source**: [https://github.com/Lidarr/Lidarr/issues/5516](https://github.com/Lidarr/Lidarr/issues/5516), [https://github.com/Lidarr/Lidarr/issues/5555](https://github.com/Lidarr/Lidarr/issues/5555)

**Confidence**: High.

### TsArr TypeScript SDK Release (2025-2026)

- **Date**: Active development through February 2026
- **What happened**: First production-quality TypeScript SDK for all Servarr APIs (including Lidarr) was developed and released on npm as `tsarr`.
- **Source**: [https://github.com/robbeverhelst/TsArr](https://github.com/robbeverhelst/TsArr)

**Confidence**: High.

## Similar Artists / Discovery Features

### Native Lidarr Capabilities

Lidarr does NOT have a built-in "similar artists" API endpoint. There is no `/api/v1/artist/similar` or equivalent. Artist discovery must be implemented externally.

**Confidence**: High -- confirmed from OpenAPI spec review showing no such endpoint exists.

### How Discovery Works in Practice

Discovery is achieved through three external approaches:

#### 1. Last.fm Recommendations (Lidify, Tubifarry)

- **Mechanism**: Query Last.fm's `artist.getSimilar` endpoint with artists from your Lidarr library
- **Workflow**: Read Lidarr library via `GET /api/v1/artist` -> Query Last.fm -> Filter out artists already in library -> Add new artists via `POST /api/v1/artist`
- **Limitations**: Last.fm's recommendation quality varies; Spotify's API (previously used) now restricted
- **Tools**: Lidify (standalone web app), Tubifarry (Lidarr plugin, uses `~` prefix in search)

#### 2. MusicBrainz Tag Matching (Aurral)

- **Mechanism**: Sample existing Lidarr artists -> Query MusicBrainz for sub-genres/tags -> Find artists with matching tag combinations
- **Workflow**: More genre/style-based than traditional "similar artist" recommendations
- **Limitations**: MusicBrainz rate limiting (1 req/sec); tag quality varies by artist popularity
- **Tools**: Aurral (Node.js/React web app)

#### 3. Import Lists (Built-in)

- **Mechanism**: Lidarr's import list feature can pull from Last.fm (user library, tag-based), Spotify (playlists, saved albums, followed artists), and other sources
- **API endpoints**: `GET/POST /api/v1/importlist`, `GET /api/v1/importlist/schema`
- **Limitations**: Not real-time discovery; runs on a schedule. Spotify integration may face future API restrictions.

### MusicBrainz as the Backbone

Lidarr's metadata infrastructure is built on MusicBrainz. The LidarrAPI.Metadata service (Python, 531 commits) runs its own MusicBrainz database mirror with PostgreSQL, Solr search, and Redis caching. All artist/album lookups go through this metadata layer.

**Confidence**: High -- verified from LidarrAPI.Metadata repository.

## Emerging Trends

### Trend 1: Shift from Spotify to Last.fm for Discovery

- **Description**: Spotify's increasingly restrictive API policies (November 2024 changes) are pushing the ecosystem toward Last.fm as the primary recommendation engine. Multiple tools have already migrated.
- **Source**: [https://github.com/TheWicklowWolf/Lidify](https://github.com/TheWicklowWolf/Lidify)

**Confidence**: High.

### Trend 2: Auto-Generated SDKs from OpenAPI Specs

- **Description**: The DevOpsArr organization and TsArr project both generate SDKs directly from Lidarr's OpenAPI specification. This ensures comprehensive endpoint coverage and reduces maintenance burden. The pattern is maturing across Python, Go, TypeScript, and Rust.
- **Source**: [https://github.com/devopsarr](https://github.com/devopsarr), [https://github.com/robbeverhelst/TsArr](https://github.com/robbeverhelst/TsArr)

**Confidence**: High.

### Trend 3: Soulseek Integration as Alternative Download Source

- **Description**: Tools like Soularr and Tubifarry bridge Lidarr with Soulseek (via Slskd) as an alternative to traditional Usenet/torrent download clients. This addresses gaps in music availability that traditional indexers miss.
- **Source**: [https://github.com/mrusse/soularr](https://github.com/mrusse/soularr)

**Confidence**: High.

### Trend 4: Plugin Architecture for Lidarr

- **Description**: Tubifarry demonstrates that Lidarr supports a plugin architecture (C# plugins). This enables extending Lidarr's search and import capabilities without modifying core code.
- **Source**: [https://github.com/TypNull/Tubifarry](https://github.com/TypNull/Tubifarry)

**Confidence**: Medium -- plugin system exists but not widely documented.

### Trend 5: CLI Tooling Gap for Lidarr

- **Description**: While Sonarr and Radarr have mature CLI tooling and configuration management (Recyclarr), Lidarr lacks equivalent CLI tools. Recyclarr explicitly does not support Lidarr. This represents a clear opportunity for rfmedia-cli.
- **Source**: [https://recyclarr.dev/](https://recyclarr.dev/), [https://github.com/recyclarr/recyclarr](https://github.com/recyclarr/recyclarr)

**Confidence**: High.

## Known API Gotchas and Pain Points

### 1. Race Condition When Adding Albums with Unmonitored Artist

When POSTing to `/api/v1/album` with `addOptions.searchForNewAlbum: true` for a newly added artist, the album monitoring status gets overwritten by the artist monitoring defaults. The album monitoring is applied before artist monitoring, causing the monitored state to be lost.

- **Source**: [https://github.com/Lidarr/Lidarr/issues/5012](https://github.com/Lidarr/Lidarr/issues/5012)
- **Confidence**: High.

### 2. External Metadata API Dependency

Lidarr's lookup and search endpoints depend on the external `api.lidarr.audio` service, which has experienced significant downtime and rate limiting. This means `/api/v1/artist/lookup` and `/api/v1/album/lookup` can fail with 500/503 errors even when your local Lidarr instance is healthy.

- **Source**: [https://github.com/Lidarr/Lidarr/issues/5498](https://github.com/Lidarr/Lidarr/issues/5498)
- **Confidence**: High.

### 3. Bulk Add Requires Delays

Community scripts for bulk-adding artists recommend 120-second delays between API calls to avoid overwhelming the metadata API.

- **Source**: [https://gist.github.com/jackskhakis/711b54352a5ee9d1ae9778f2060ce444](https://gist.github.com/jackskhakis/711b54352a5ee9d1ae9778f2060ce444)
- **Confidence**: Medium -- community observation, not officially documented rate limits.

### 4. No Documented Rate Limits

Lidarr's local API does not appear to have explicit rate limits for local requests. However, operations that trigger metadata lookups are effectively rate-limited by the upstream `api.lidarr.audio` service.

- **Confidence**: Medium.

### 5. Large Library Pagination

The `/wanted/missing` endpoint can return 270,000+ entries. Callers must implement pagination with reasonable page sizes to avoid timeout issues.

- **Source**: [https://github.com/plexguide/Huntarr.io/issues/565](https://github.com/plexguide/Huntarr.io/issues/565)
- **Confidence**: High.

### 6. Monitor "none" Ignores Album Monitored Flags

Adding an artist with `addOptions.monitor: "none"` disregards individual album `monitored` flags, effectively unmonitoring everything regardless of per-album settings.

- **Source**: [https://github.com/Lidarr/Lidarr/issues/3597](https://github.com/Lidarr/Lidarr/issues/3597)
- **Confidence**: High.

## Key Insights

1. **The Lidarr API is comprehensive but under-documented**: The OpenAPI spec covers 80+ endpoints with full CRUD for artists, albums, tracks, quality profiles, and more. However, there are no official usage guides, tutorials, or example scripts. Community tools and SDK documentation (especially pyarr) serve as the de facto API reference.

2. **Similar artist discovery is the biggest integration opportunity**: Lidarr has NO native similar-artists API. External tools (Lidify, Aurral, Tubifarry) have filled this gap with Last.fm and MusicBrainz integrations, but none offer a CLI-based experience. A CLI tool that combines Lidarr's library data with Last.fm/MusicBrainz recommendations would fill a clear ecosystem gap.

3. **TypeScript integration is newly viable**: The TsArr SDK (v1.11.0, February 2026) provides the first production-quality TypeScript client for Lidarr, auto-generated from the OpenAPI spec. However, it uses Bun as its runtime -- rfmedia-cli would need to evaluate whether to use TsArr directly, fork/adapt it for Node.js, or generate its own client from the OpenAPI spec.

4. **The bulk operations API is powerful but tricky**: `PUT /api/v1/artist/editor` (bulk update) and `DELETE /api/v1/artist/editor` (bulk delete) enable efficient batch operations. `PUT /api/v1/album/monitor` enables mass monitor/unmonitor. These are high-value for CLI tooling but have subtle behavioral quirks (race conditions, monitoring flag overrides).

5. **Lidarr's metadata infrastructure is the bottleneck**: The external `api.lidarr.audio` service (backed by MusicBrainz) is a single point of failure. Search/lookup operations depend on it, and it has experienced recurring outages. CLI tools should implement retry/backoff logic and graceful degradation when metadata lookups fail.

6. **Recyclarr gap = opportunity**: Recyclarr (TRaSH Guides sync) explicitly does not support Lidarr. A CLI tool that helps manage Lidarr quality profiles, custom formats, and naming conventions would address a known community need.

7. **The Plex-Lidarr bridge is underserved**: While both Plex and Lidarr manage music libraries, there is no established tool that bridges them for cross-referencing (e.g., "what artists are in Plex but not monitored in Lidarr?" or "sync Plex ratings back to Lidarr"). This is a unique opportunity for rfmedia-cli given its existing Plex integration.

## Evidence Quality

- **Recent sources (2024-2026)**: 15+ sources
- **Primary sources**: Official OpenAPI spec, GitHub releases, GitHub issues, SDK repositories
- **Secondary sources**: Community scripts (Gists), third-party tool READMEs
- **Overall confidence rating**: High -- findings are well-corroborated across multiple independent sources
- **Key gap**: Exact request/response body schemas for bulk editor endpoints (artist/editor, album/monitor) need verification against the OpenAPI JSON spec directly

## Uncertainties and Gaps

1. **TsArr Node.js compatibility**: TsArr is built for Bun runtime. Whether it works with Node.js without modification needs testing.
2. **Custom format API completeness**: Custom formats are a newer feature (v3.1.x) and may have incomplete SDK support in older libraries.
3. **Import list API details**: The exact schema for creating Spotify/Last.fm import lists via API is complex and not well-documented outside the Terraform provider.
4. **Artist editor bulk update body format**: The exact JSON body structure for `PUT /api/v1/artist/editor` needs extraction from the OpenAPI spec (not available in summarized search results).
5. **Webhook/real-time events**: Whether Lidarr supports WebSocket connections or server-sent events for real-time monitoring (beyond webhook notifications) is unclear.

## Search Queries Executed

1. "Lidarr API documentation 2025 2026 endpoints REST"
2. "Lidarr REST API artist album endpoints reference v1"
3. "Lidarr API wrapper library TypeScript JavaScript npm"
4. "Lidarr similar artists API endpoint discovery"
5. "Lidarr API v1 authentication apikey X-Api-Key header"
6. "Lidarr bulk operations API mass edit monitor unmonitor"
7. "Recyclarr Notifiarr Lidarr integration 2025"
8. "Lidarr API add artist search lookup POST artist"
9. "devopsarr typescript servarr SDK npm lidarr sonarr radarr"
10. "site:github.com starr lidarr golang API client endpoints"
11. "Lidarr version 2025 2026 latest release changelog"
12. "Lidarr API command endpoint RefreshArtist AlbumSearch MissingAlbumSearch"
13. "Lidarr API album monitor endpoint PUT body albumIds monitored JSON"
14. "Lidarr metadata provider MusicBrainz Last.fm API similar artists tags"
15. "Lidarr API artist editor bulk update delete endpoint body format"
16. "Lidarr API wanted missing cutoff albums endpoint pagination"
17. "Buildarr Lidarr configuration management tool"
18. "Lidarr API known issues gotchas rate limiting pagination 2024 2025"
19. "Lidarr API delete artist endpoint deleteFiles addImportListExclusion parameters"
20. "Lidarr monitor options all future missing existing first latest none artist addOptions"
21. "tsarr npm package version downloads lidarr typescript"
22. "Soularr Lidarr Soulseek integration API how it works"
23. "Lidarr import list Spotify Last.fm Lidarr lists API endpoint"

## Deep-Fetched Sources

1. [Lidarr API Docs (Swagger UI)](https://lidarr.audio/docs/api/) -- OpenAPI spec loader
2. [Lidarr docs.sh (GitHub)](https://github.com/Lidarr/Lidarr/blob/develop/docs.sh) -- OpenAPI generation script
3. [pyarr LidarrAPI Documentation](https://docs.totaldebug.uk/pyarr/modules/lidarr.html) -- Comprehensive method listing
4. [Lidarr OpenAPI JSON Spec](https://raw.githubusercontent.com/lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json) -- Full endpoint catalog
5. [Lidify (GitHub)](https://github.com/TheWicklowWolf/Lidify) -- Last.fm discovery tool
6. [Aurral (GitHub)](https://github.com/lklynet/aurral) -- MusicBrainz-based discovery
7. [TsArr (GitHub)](https://github.com/robbeverhelst/TsArr) -- TypeScript SDK
8. [lidarr-py (GitHub)](https://github.com/devopsarr/lidarr-py) -- Python auto-generated SDK
9. [golift/starr Lidarr Go Package](https://pkg.go.dev/github.com/craigjmidwinter/starr/lidarr) -- Go client functions
10. [Lidarr Releases (GitHub)](https://github.com/lidarr/Lidarr/releases) -- Version history
11. [awesome-arr (GitHub)](https://github.com/Ravencentric/awesome-arr) -- Ecosystem tool listing
12. [Album Monitor/Unmonitor Script (Gist)](https://gist.github.com/jordandrako/e7082a6ad3d90b85df36017bb97a02f3) -- Bulk monitor shell script
13. [Bulk Add Artists Script (Gist)](https://gist.github.com/jackskhakis/711b54352a5ee9d1ae9778f2060ce444) -- Batch artist addition
14. [Huntarr-Lidarr api.py (GitHub)](https://github.com/plexguide/Huntarr-Lidarr/blob/main/api.py) -- Practical API usage
15. [Tubifarry (GitHub)](https://github.com/TypNull/Tubifarry) -- Lidarr plugin with Similar Artists
16. [LidarrAPI.Metadata (GitHub)](https://github.com/Lidarr/LidarrAPI.Metadata) -- Metadata backend
17. [Lidarr Issue #5012](https://github.com/Lidarr/Lidarr/issues/5012) -- Album monitoring race condition
18. [Lidarr Issue #5579](https://github.com/Lidarr/Lidarr/issues/5579) -- API reliability issues
19. [TsArr Documentation](https://robbeverhelst.github.io/Tsarr/) -- SDK docs site
