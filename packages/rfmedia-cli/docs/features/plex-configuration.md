# Plex Configuration Guide

This guide covers the Plex integration configuration options available in rfmedia-cli's `.rfmedia.yaml` configuration file.

## Configuration File Location

rfmedia-cli looks for configuration files in the following order:

1. `.rfmedia.yaml` in the current directory
2. `.rfmedia.yml` in the current directory
3. `.rfmedia.json` in the current directory
4. Searches up the directory tree for any of the above

## Basic Plex Configuration

The minimal configuration for Plex integration:

```yaml
plex:
  url: "http://localhost:32400"
  token: "YOUR_PLEX_TOKEN"
```

### Getting a Credential

There are two ways to give rfmedia a Plex credential.

**Option A — enroll this device (recommended).** No token is copied by hand and nothing
credential-shaped is written to the config file:

```bash
rfmedia plex auth login
```

See [Account Enrollment (JWT)](#account-enrollment-jwt) below.

**Option B — copy a token from the Plex Web App:**

1. Sign in to Plex Web App
2. Open any media item and click the "..." menu
3. Select "Get Info" or "View XML"
4. Look for `X-Plex-Token=` in the URL
5. Copy the token value (do NOT commit this to version control)

## Full Configuration Reference

```yaml
plex:
  # Required: Plex Media Server URL
  url: "http://localhost:32400"

  # Opaque legacy Plex token or already-issued Plex JWT.
  # Required unless this device is enrolled (see plex.auth below).
  token: "YOUR_PLEX_TOKEN"

  # Credential-source policy (all fields optional)
  auth:
    # "static" (default) or "jwt". "jwt" uses the enrolled credential and never
    # falls back to a static token.
    mode: static
    # Credential-store path override. A path, never a secret.
    storePath: "~/.config/rfmedia/plex-auth/store.json"
    # Device label shown in your Plex account. Defaults to the host name.
    deviceName: "workstation"
    # Proactive refresh margin in seconds (default 300, min 60, max 86400)
    refreshMarginSeconds: 300

  # Default library for operations (optional)
  libraryName: "Music"

  # Default Plex API page size (integer from 1 through 1000)
  pageSize: 250

  # Trigger library scan after copy operations (default: false)
  scanAfterCopy: true

  # Scan after each source instead of at end of batch (default: false)
  scanPerSource: false

  # Default filters for plex query/copy commands
  defaultFilters:
    minRating: 3.5 # Minimum star rating (0-5 scale)
    genre: "Rock" # Filter by genre
    minPlays: 5 # Minimum play count
    excludeGenres: # Genres to exclude
      - "Holiday"
      - "Christmas"

  # Rating sync defaults for plex sync push/pull
  ratingSyncDefaults:
    prefer: "file" # "file" or "plex" - which rating takes precedence
    onlyRated: true # Only sync items with ratings
    popmEmail: "no@email" # Email for POPM ratings in MP3 files
    vorbisScale: 100 # Rating scale for Vorbis comments (1, 5, or 100)

  # Sync-on-copy: write Plex ratings to copied files (default: false)
  syncRatingsOnCopy: false
  syncOnCopyDefaults:
    popmEmail: "no@email" # POPM email for MP3 rating writes
    vorbisScale: "normalized" # Vorbis scale: normalized, stars, percent

  # Playlist creation defaults (awaiting plex playlist create command)
  playlistDefaults:
    smart: false # Create smart (dynamic) vs static playlists
    updateExisting: false # Update existing playlist or error if exists

  # API response caching
  cache:
    enabled: true # Enable in-memory TTL caching for Plex API responses
    ttlSeconds: 300 # Cache time-to-live in seconds

  # Library path mappings for automatic library detection
  libraries:
    - path: "/mnt/media/music"
      library: "Music"
    - path: "/mnt/media/audiobooks"
      library: "Audiobooks"
```

## Configuration Options

### Core Settings

| Option        | Type   | Required | Default | Description                                                                       |
| ------------- | ------ | -------- | ------- | --------------------------------------------------------------------------------- |
| `url`         | string | Yes      | -       | Plex Media Server URL (e.g., `http://ip:32400`)                                   |
| `token`       | string | See note | -       | Opaque legacy token or already-issued Plex JWT                                    |
| `auth`        | object | No       | -       | Credential-source policy; see [Account Enrollment (JWT)](#account-enrollment-jwt) |
| `libraryName` | string | No       | -       | Default library for scan/query operations                                         |
| `pageSize`    | number | No       | `100`   | Plex API page size; integer from 1 through 1000                                   |

`token` is required unless this device is enrolled with `rfmedia plex auth login`. Exactly one
credential source is used per invocation; see the precedence table below.

### Credential Settings (`plex.auth`)

| Option                 | Type   | Default                                  | Description                                                     |
| ---------------------- | ------ | ---------------------------------------- | --------------------------------------------------------------- |
| `mode`                 | string | `static`                                 | `static` keeps pre-#251 behavior; `jwt` requires an enrollment  |
| `storePath`            | string | `~/.config/rfmedia/plex-auth/store.json` | Credential-store path. Tilde-expanded. A path, never a secret   |
| `deviceName`           | string | system host name                         | Device label shown in your Plex account. Non-secret             |
| `refreshMarginSeconds` | number | `300`                                    | Proactive refresh window, in seconds. Minimum 60, maximum 86400 |

An absent `auth` block and `mode: static` behave identically. Opting out of the enrollment store
means deleting the store (`rfmedia plex auth logout`), not renaming a mode.

### Scan Settings

| Option          | Type    | Default | Description                                      |
| --------------- | ------- | ------- | ------------------------------------------------ |
| `scanAfterCopy` | boolean | `false` | Trigger Plex scan after copy operations complete |
| `scanPerSource` | boolean | `false` | Scan after each source instead of at end         |

### Default Filters

Configure default filters for `plex query` and `plex copy` commands:

| Option          | Type     | Description                                  |
| --------------- | -------- | -------------------------------------------- |
| `minRating`     | number   | Minimum star rating (0-5 scale, decimals OK) |
| `genre`         | string   | Filter to specific genre                     |
| `minPlays`      | number   | Minimum play count (viewCount)               |
| `excludeGenres` | string[] | Genres to exclude from results               |

### Rating Sync Defaults

Configure defaults for `plex sync push`, `plex sync pull`, and `plex sync both`. Used when `--popm-email` and `--vorbis-scale` are **not** provided on the CLI; explicit flags override config.

| Option        | Type    | Values             | Description                       |
| ------------- | ------- | ------------------ | --------------------------------- |
| `prefer`      | string  | `"file"`, `"plex"` | Which rating takes precedence     |
| `onlyRated`   | boolean | -                  | Only sync items that have ratings |
| `popmEmail`   | string  | -                  | Email for MP3 POPM frames         |
| `vorbisScale` | number  | `1`, `5`, `100`    | Scale for Vorbis RATING comments  |

### Playlist Defaults

Configure defaults for future `plex playlist create` command:

| Option           | Type    | Default | Description                              |
| ---------------- | ------- | ------- | ---------------------------------------- |
| `smart`          | boolean | `false` | Create smart (auto-updating) playlists   |
| `updateExisting` | boolean | `false` | Update existing playlist if name matches |

**Note:** These options are validated but await the `plex playlist create` command implementation.

### Sync-on-Copy Options

Configure defaults for automatic rating synchronization during `plex copy` and `plex playlist export` operations. `syncOnCopyDefaults` values are used when `--popm-email` and `--vorbis-scale` are **not** provided on the CLI; explicit flags override config.

| Option                           | Type    | Default        | Description                                    |
| -------------------------------- | ------- | -------------- | ---------------------------------------------- |
| `syncRatingsOnCopy`              | boolean | `false`        | Enable rating sync during copy/export          |
| `syncOnCopyDefaults.popmEmail`   | string  | `"no@email"`   | POPM email identifier for MP3 rating writes    |
| `syncOnCopyDefaults.vorbisScale` | string  | `"normalized"` | Vorbis scale: `normalized`, `stars`, `percent` |

Example configuration:

```yaml
plex:
  syncRatingsOnCopy: true
  syncOnCopyDefaults:
    popmEmail: "user@example.com"
    vorbisScale: "stars"
```

**Behavior Notes:**

- Starting with the fix for #289, these settings are validated and take effect when loaded.
  Existing configurations that already set `syncRatingsOnCopy: true` will therefore begin writing
  ratings after upgrade.
- When enabled, Plex ratings are written to destination file metadata during copy
- Unrated tracks (`userRating === 0`) are skipped - 0 means unrated, not zero stars
- Only MP3 (POPM) and FLAC (Vorbis) formats support rating writes
- OGG, Opus, and M4A files are skipped with a warning
- With hardlink mode, a warning is displayed since writing modifies the original file

### Cache Configuration

Configure adapter-local in-memory TTL caching for Plex API responses. When enabled, repeated API
calls through the same adapter instance return cached results instead of making redundant HTTP
requests.

| Option       | Type    | Default | Description                                                   |
| ------------ | ------- | ------- | ------------------------------------------------------------- |
| `enabled`    | boolean | `false` | Enable in-memory TTL caching for Plex API responses           |
| `ttlSeconds` | number  | `300`   | Time-to-live in seconds for cached entries (positive integer) |

**Cached categories:**

- Server identity
- Library section listings
- Query pages and album-track results
- Playlist listings
- Collection listings per library

**Automatic cache invalidation:**

Write operations automatically invalidate related caches to ensure subsequent reads reflect the latest state:

- Successful playlist create, add, and delete operations invalidate playlist listings
- Successful collection create, add, and delete operations invalidate collection listings
- Successful rating updates invalidate cached query results

**Important:** Each resolved adapter owns an isolated cache for its credential lifecycle. The cache
is in-memory only and is not persisted across separate `rfmedia` commands. See
[plex-api-caching.md](plex-api-caching.md) for the complete lifecycle and key rules.

Example configuration:

```yaml
plex:
  cache:
    enabled: true
    ttlSeconds: 300
```

### Library Path Mappings

Map local paths to Plex libraries for automatic library detection:

```yaml
plex:
  libraries:
    - path: "/mnt/media/music"
      library: "Music"
    - path: "/mnt/media/playlists"
      library: "Playlists"
```

When copying to `/mnt/media/music/Artist/Album`, rfmedia automatically:

1. Matches the path to the "Music" library
2. Triggers a path-based scan for just that directory
3. Avoids scanning the entire library

## Media Server Adapter Resolution

Action handlers no longer construct Plex connection objects directly. They resolve a `MediaServerAdapter` using the shared adapter factory:

- Required mode for query/CRUD workflows
- Optional mode for scan-only follow-up workflows

This keeps Plex-specific config precedence and validation in one place (`src/lib/adapters/index.ts`).

Connection overrides are origin-bound:

- A same-origin `--plex-url` override may continue using the configured credential.
- A `--plex-url` that changes the canonical origin requires an explicit `--plex-token`. An
  enrollment does not satisfy this — the guard is a presence test on `--plex-token` itself.
- An explicit token override may continue using the configured URL.
- A paired URL and token override remains supported after URL validation.

The URL must be a bare HTTP(S) origin without credentials, a path, query parameters, or a
fragment. Authenticated redirects are rejected. These rules prevent a configured credential from
being inherited by a different server while preserving established local and MCP override flows.

For implementation and testing rules, see [media-server-adapter.md](media-server-adapter.md).

## Account Enrollment (JWT)

`rfmedia plex auth` enrolls this device with your Plex account and manages the resulting
credential, so no token has to be copied out of the Plex Web App and none is stored in the config
file.

```bash
rfmedia plex auth login    # enroll this device
rfmedia plex auth status   # report enrollment and credential state (offline)
rfmedia plex auth refresh  # rotate the stored credential
rfmedia plex auth logout   # destroy local enrollment material
```

### Commands and Flags

| Command   | Flags                                                                          |
| --------- | ------------------------------------------------------------------------------ |
| `login`   | `--plex-url <url>`, `--device-name <name>`, `--timeout <seconds>`, `-y, --yes` |
| `status`  | `--plex-url <url>`                                                             |
| `refresh` | `--plex-url <url>`, `--timeout <seconds>`, `--force`                           |
| `logout`  | `--plex-url <url>`, `-y, --yes`                                                |

**No flag in this group takes a secret value.** There is no `--plex-jwt`, `--plex-pin`, or
`--plex-refresh-token`. Every flag is a reference — a URL, a label, a number of seconds — so
nothing credential-shaped appears in `ps` output or shell history.

Notes:

- `--force` on `refresh` means "rotate now even though the credential is still fresh". It cannot
  bypass a Plex rate limit: when the server-imposed window has not elapsed, the command reports the
  remaining wait and exits `1` with `PLEX_AUTH_RATE_LIMITED`.
- `-y, --yes` is required for `logout`, and for a `login` that would replace an existing
  enrollment, whenever the output format is machine-readable or the session is not interactive.
- `login` prints the authorization link to **stderr** and polls; it opens no browser and works
  headlessly. `stdout` stays parseable in every mode.
- `status` makes **no network call**, so it stays usable while plex.tv is unreachable or is rate
  limiting your address. Its `clockSkewSeconds` is the last persisted observation, not a live one.

### JSON Output

All four verbs emit `{ "command": "plex-auth-<verb>", "result": … }` on stdout under
`--output json`, and `{ "command": …, "error": { message, code, retryable, retryAfterSeconds,
statusCode, remediation, diagnostics? } }` on failure, with exit code `1`.

`--output <format>` and `--json` are declared on the **root** command and reconciled by `cli.ts`'s
`preAction` hook. Commander recognizes root options on either side of a subcommand, so both
positions are parsed identically:

```bash
rfmedia --output json plex auth status   # JSON
rfmedia plex auth status --output json   # JSON, identical
```

Passing both `--json` and `--output` lets `--output` win, with a warning. No `plex auth` verb
declares an `--output` of its own, so neither position is shadowed.

No envelope ever contains the credential, the signing key, the authorization code, a nonce, or a
device assertion. `kid` (an RFC 7638 public thumbprint) and `clientIdentifier` are non-secret by
design.

### Credential Precedence

Exactly one credential source is chosen, once, at adapter construction. There is no per-request
"try JWT, fall back to the token" chain — that would be a credential-downgrade oracle.

| #   | Source                               | Behavior                                                                                            |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | `--plex-token`                       | Wins unconditionally; the only escape hatch that unlocks a cross-origin `--plex-url`                |
| 2   | `plex.auth.mode: jwt`                | Enrolled credential for the resolved origin. Not enrolled ⇒ error, **never** falls back             |
| 3   | `plex.token` (including `{{ VAR }}`) | A deliberately-set token outranks the store, so the store can never silently swap it                |
| 4   | Enrolled credential (opportunistic)  | Used only when neither 1 nor 3 exists. Origin-keyed, so it is never used for an unauthorized origin |
| 5   | none                                 | The existing "Plex URL and token are required" failure                                              |

Setting `plex.auth.mode: jwt` **and** `plex.token` is reported, not resolved: the command fails
with a message telling you to remove one of them.

The cross-origin guard is unchanged: a `--plex-url` that changes the canonical origin still
requires an explicit `--plex-token`. **An enrollment does not unlock an origin change.** The
`rfmedia plex auth` verbs are the exception by design — they mint or destroy a credential for the
origin you just named, rather than redirecting one you already hold.

### The Credential Store

| Property       | Value                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| Default path   | `~/.config/rfmedia/plex-auth/store.json`                                            |
| Override order | `RFMEDIA_PLEX_AUTH_DIR` (a directory), then `plex.auth.storePath`, then the default |
| File mode      | `0600`, inside a `0700` directory                                                   |
| Lock file      | `<storePath>.lock`, reported by `plex auth status` as `lockPath`                    |
| Contents       | Ed25519 private key, credential, client identifier, authorized origins              |

`RFMEDIA_PLEX_AUTH_DIR` mirrors the existing `RFMEDIA_PLAN_DIR` convention: it names a
**directory**, and `store.json` is created inside it.

Limitations, all deliberate:

- **The store must live on a local filesystem.** Atomicity and single-flight refresh rely on
  `link(2)`/`rename(2)` semantics and on `{dev, ino}` identity checks that NFS, SMB, and many
  container-shared mounts do not provide.
- The store is **not** `{{ VAR }}`-templated and is never read by the config loader. It is
  out-of-band on purpose: no secret is introduced into any config file.
- rfmedia never repairs permissions silently. A store readable by anyone other than its owner
  fails with `PLEX_AUTH_STORE_PERMISSIONS` and a `chmod 600 <path>` remediation.
- A lock held by a live process on another host is respected; a lock older than 120 seconds is
  considered stale and stolen exactly once. There is no `--force-unlock`.

### Enrollment Requires a Reachable Server

`login` mints a credential, then **probes your Plex Media Server with it before persisting
anything**. If the server is unreachable or rejects the credential, the command fails
(`PLEX_AUTH_UNREACHABLE` or `PLEX_AUTH_PMS_REJECTED`) and the freshly minted credential is
discarded — no store file is created. There is no `--skip-probe`.

Start your Plex server before enrolling. Each retry mints a new PIN against a **per-IP** budget
(measured: 10 per 300 seconds), so repeated attempts against a down server will eventually be rate
limited.

### Migration

Every step is independently reversible, and your existing `plex.token` stays a working credential
throughout.

1. **Enroll.** Writes only the credential store. Nothing enters the config file or the repository.

   ```bash
   rfmedia plex auth login
   ```

2. **Confirm.** Check origin, expiry, and store mode. Never prints the credential.

   ```bash
   rfmedia plex auth status
   ```

3. **Verify with a real read**, still on the static token (precedence branch 3):

   ```bash
   rfmedia plex query list
   ```

4. **Opt in.** Add the credential-source policy:

   ```yaml
   plex:
     auth:
       mode: jwt
   ```

5. **Only then** remove `plex.token` from the config file.

Steps 4 and 5 are optional: with `plex.token` removed and no `auth` block at all, the enrolled
credential is picked up opportunistically (branch 4).

We deliberately route enrollment through a fresh PIN rather than the alternative upgrade endpoint,
because Plex documents that the alternative expires your legacy token. A config change is
reversible; a destroyed token is not.

### Rollback

1. Set `plex.auth.mode: static` (or delete the `auth` block).
2. Restore `plex.token` (or `token: "{{ PLEX_TOKEN }}"`).
3. Optionally destroy the local material:

   ```bash
   rfmedia plex auth logout
   ```

**Files you touch: `.rfmedia.yaml`, one key.** There is no database schema change and no rewritten
history, tracking, or queue row — the reason enrollment lives in a dedicated store file rather than
in `tracking.db`.

`rfmedia init --merge` is safe: existing values win, and `token: "{{ PLEX_TOKEN }}"` survives
verbatim.

### Revocation Is Local

`rfmedia plex auth logout` destroys the local signing key and credential. **It does not revoke the
device server-side** — Plex documents no client-callable revocation endpoint. Every `logout` result
reports `serverSideRevocation: "manual"` and links to your Plex Authorized Devices page; remove the
device there to complete revocation.

## CLI Override Options

All configuration options can be overridden via CLI flags:

```bash
# Override URL and token
rfmedia plex query --plex-url http://192.168.1.100:32400 --plex-token TOKEN

# Override library
rfmedia copy /source /dest --plex-library "My Music"

# Enable/disable scan
rfmedia copy /source /dest --plex-scan
rfmedia copy /source /dest --no-plex-scan

# Per-source scanning
rfmedia copy /source /dest --plex-per-source
```

## Example Configurations

### Minimal Configuration

```yaml
plex:
  url: "http://localhost:32400"
  token: "YOUR_TOKEN_HERE"
  scanAfterCopy: true
```

### Music Library with Filters

```yaml
plex:
  url: "http://plex.local:32400"
  token: "YOUR_TOKEN_HERE"
  libraryName: "Music"
  scanAfterCopy: true
  defaultFilters:
    minRating: 4
    excludeGenres:
      - "Holiday"
      - "Podcast"
```

### Multi-Library Setup

```yaml
plex:
  url: "http://plex.local:32400"
  token: "YOUR_TOKEN_HERE"
  scanPerSource: true
  libraries:
    - path: "/mnt/music/rock"
      library: "Rock Collection"
    - path: "/mnt/music/jazz"
      library: "Jazz Collection"
    - path: "/mnt/music/classical"
      library: "Classical"
```

### Rating Sync Configuration

```yaml
plex:
  url: "http://plex.local:32400"
  token: "YOUR_TOKEN_HERE"
  libraryName: "Music"
  ratingSyncDefaults:
    prefer: "file"
    onlyRated: true
    popmEmail: "ratings@example.com"
    vorbisScale: 100
```

### Sync-on-Copy Configuration

Enable automatic rating synchronization during copy operations:

```yaml
plex:
  url: "http://plex.local:32400"
  token: "YOUR_TOKEN_HERE"
  libraryName: "Music"
  scanAfterCopy: true
  syncRatingsOnCopy: true
  syncOnCopyDefaults:
    popmEmail: "ratings@example.com"
    vorbisScale: "stars"
```

## Migration from CLI Flags

If you're currently using CLI flags for Plex settings, you can migrate to config file:

### Before (CLI flags)

```bash
rfmedia copy /source /dest \
  --plex-url http://localhost:32400 \
  --plex-token TOKEN \
  --plex-library Music \
  --plex-scan
```

### After (Config file)

```yaml
# .rfmedia.yaml
plex:
  url: "http://localhost:32400"
  token: "YOUR_TOKEN_HERE"
  libraryName: "Music"
  scanAfterCopy: true
```

```bash
# Now just:
rfmedia copy /source /dest
```

## Security Considerations

**Never commit your Plex token to version control.**

`token` is an opaque compatibility field. It accepts a legacy Plex token or an already-issued JWT
without decoding or changing it. rfmedia sends the credential only in the `X-Plex-Token` request
header; it is not placed in request URLs, cache keys, or diagnostic output.

Recommended approaches:

1. **Enrollment**: run `rfmedia plex auth login` and omit `token` entirely — no credential ever
   enters the config file
2. **Environment Variables**: Use environment variable substitution in config
3. **Separate Config**: Keep `.rfmedia.yaml` in `.gitignore`
4. **CLI Override**: Pass token via CLI flag for sensitive operations

Prefer enrollment over `--plex-token` for routine use: a flag value is visible in `ps` output and
in shell history. No `rfmedia plex auth` flag accepts a secret for exactly this reason.

The enrollment store is deliberately out-of-band. It is not `{{ VAR }}`-templated, is never read by
the config loader, and no new secret-bearing config field is introduced by it. Config redaction
also covers the credential-shaped key names (`privatekey`, `jwt`, `nonce`, `pincode`, `credential`,
`devicejwt`) so a hand-written `plex.*` key cannot leak through debug output.

Example `.gitignore`:

```gitignore
# rfmedia config with secrets
.rfmedia.yaml
.rfmedia.yml
.rfmedia.json
```

## Troubleshooting

### Connection Errors

- Verify URL is correct and Plex server is running
- Check firewall allows connections on port 32400
- Ensure the token is valid; when diagnosing manually, send it in the `X-Plex-Token` header rather
  than adding it to a URL
- If `--plex-url` changes the configured origin, also pass the matching `--plex-token`
- If you enrolled instead of configuring a token, run `rfmedia plex auth status` to confirm which
  origins the enrollment covers and how long the credential has left

### Library Not Found

- Run `rfmedia plex query --list-libraries` to see available libraries
- Library names are case-sensitive

### Scan Not Triggering

- Ensure `scanAfterCopy: true` is set
- Check `--no-plex-scan` isn't being passed
- Verify token has permission to trigger scans

### Enrollment Errors

Every failure carries a stable `code` and a `remediation` naming the exact next command.

| Code                              | Meaning and fix                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `PLEX_AUTH_NOT_ENROLLED`          | No enrollment for this origin. Run `rfmedia plex auth login`                      |
| `PLEX_AUTH_ORIGIN_NOT_AUTHORIZED` | Enrolled, but not for this server. Run `rfmedia plex auth login --plex-url <url>` |
| `PLEX_AUTH_STORE_PERMISSIONS`     | Store is group/world readable. Run `chmod 600 <path>`                             |
| `PLEX_AUTH_STORE_UNSAFE_PATH`     | A symlink, foreign owner, or writable parent on the store path                    |
| `PLEX_AUTH_STORE_CORRUPT`         | Delete the store, then re-run `rfmedia plex auth login`                           |
| `PLEX_AUTH_REFRESH_BUSY`          | Another rfmedia process holds the lock named by `status`'s `lockPath`             |
| `PLEX_AUTH_RATE_LIMITED`          | Per-IP budget exhausted; `retryAfterSeconds` says how long to wait                |
| `PLEX_AUTH_UNREACHABLE`           | Plex could not be reached; start the server and retry                             |
| `PLEX_AUTH_PMS_REJECTED`          | Your server refused the new credential. Nothing was persisted                     |
| `PLEX_AUTH_CLOCK_SKEW`            | The credential was already expired when issued; fix this system's clock           |
| `PLEX_AUTH_INVALID_RESPONSE`      | Plex returned a shape this build does not recognize; re-run with `--debug`        |

If enrollment fails with `PLEX_AUTH_INVALID_RESPONSE`, re-run with `--debug` and report the
`observedKeys` diagnostics. The JWT token endpoint's success body has not been observed against a
live Plex account in this build, so a wire-shape change surfaces as this error rather than as a
wrong credential.

---

_Last Updated: July 2026_
