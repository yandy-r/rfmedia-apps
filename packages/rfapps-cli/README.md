# rfapps

Docker orchestration CLI for rfmedia-apps - TypeScript replacement for manage.sh.

## Overview

`rfapps` is a modern TypeScript CLI that provides Docker Compose orchestration for the rfmedia-apps
self-hosting platform. It replaces the legacy `manage.sh` bash script with a type-safe, feature-rich
alternative.

**Key Features:**

- Shell completion for bash, zsh, and fish
- Multiple output formats (JSON, YAML, CSV, table, text) for scripting and automation
- Type-safe command building with TypeScript
- Shared utilities from `@rfmedia/common`
- Automatic Tailscale sidecar linking
- Service group support for common operations
- Docker Compose profile integration
- Smart dependency readiness waiting (container state/health + TCP probes)
- Dedicated `health` command for dependency readiness checks
- Read-only `audit` command for resolved compose security posture
- Read-only `doctor` diagnostics for runtime, config, updates, and state health
- **Opt-in vulnerability scanning** for `plan` and `deploy` with a fail-closed pre-mutation gate
- **Compose security hardening** via `harden`: propose, emit an override fragment, or apply in place
- Read-only `drift detect/show` for compose and runtime drift with explicit mutation paths
- Report-first `reconcile` with explicitly authorized, target-only convergence
- **Plan/Apply workflow** - Preview changes before deploying (Terraform-inspired)
- **Managed image updates** - Preview, review, apply, verify, and recover exact image identities
- **Native cold backup** - Archive Compose bind directories and named volumes, then verify offline
- **State persistence** - SQLite-based deployment history tracking
- **Generational snapshots** - Immutable Nix-style generations per service with
  restore-by-generation and restore-by-time
- **Rollback capabilities** - Restore services to previous deployment states
- **MCP server mode** - Expose rfapps tools over stdio JSON-RPC

## Installation

### From Monorepo Root

Link the CLI globally for system-wide access:

```bash
npm run link:rfapps
```

After linking, you can use `rfapps` directly from anywhere:

```bash
rfapps status
rfapps deploy -s plex --yes
```

### Development Mode

Run commands directly without building:

```bash
npm run rfapps -- [command]
```

Example:

```bash
npm run rfapps -- status --all
npm run rfapps -- deploy --group media-stack
```

## Configuration

`rfapps` uses a layered configuration system with YAML files. Configuration is loaded from multiple
locations with the following priority (highest first):

1. `.rfapps.yaml` in current working directory (project-specific)
2. `~/.config/rfapps/config.yaml` (XDG config directory)
3. `~/.rfapps.yaml` (home directory dotfile)
4. `rfapps.config.yaml` in project root (default configuration, ships with repo)

### Quick Start

Generate a configuration file from your `compose.yml`:

```bash
# Create project-specific config
rfapps init

# Create global config
rfapps init --global

# Preview without writing
rfapps init --dry-run
```

### Configuration File Structure

The configuration file defines service mappings, groups, and profiles:

```yaml
# Default paths
composePath: compose.yml
envFile: .env.local

# Service-to-sidecar mappings (disabled in default rfapps.config.yaml)
sidecars:
  enabled: false
  mapping: {}

# Predefined service groups for batch operations
groups:
  infra-stack:
    - docktail
    - traefik
    - cloudflared
  media-stack:
    - plex
    - jellyfin
    - sonarr
    - radarr
  # ... more groups

# Service-to-profile mappings
profiles:
  defaultProfile: all
  validProfiles:
    - core
    - infrastructure
    - downloads
    - arr-stack
    - media
    - photos
    - all
  mapping:
    docktail: core
    traefik: core
    cloudflared: core
    plex: media
    # ... more mappings

# Health check configuration
healthCheck:
  timeout: 60
  interval: 5
  retries: 12
  waitForReady: true

# Docker configuration
docker:
  sshRetry:
    maxRetries: 3
    delayMs: 2000

# Environment tool configuration
envTool:
  tool: dotenvx
```

### Customizing Configuration

You can override any setting in a local `.rfapps.yaml` file:

```yaml
# .rfapps.yaml - Override defaults
sidecars:
  enabled: false # Disable automatic sidecar linking

groups:
  custom-stack: # Add custom service group
    - service1
    - service2

profiles:
  defaultProfile: media # Change default profile
```

### Configuration Validation

The CLI automatically validates your configuration against `compose.yml` and warns about: Validation
uses an in-process cache for the compose parsing step within a single CLI run, so repeated checks
avoid redundant work without changing warning semantics. The cache resets on every run.

- Services in compose.yml not defined in config
- Services in config not found in compose.yml
- Invalid sidecar references
- Invalid profile assignments

Warnings are shown during `deploy` and `build` operations:

```bash
$ rfapps deploy -s myservice --yes
⚠️  Service 'myservice' found in compose.yml but not defined in config profiles [myservice]
Deploying services...
```

### Migration from Hardcoded Values

If you're upgrading from an older version of rfapps, the configuration is now required. Run
`rfapps init` to generate a configuration file from your existing `compose.yml`.

## Commands

### State mutation locking

rfapps serializes state-changing CLI commands and MCP tools with a private cross-process lock in
the selected state directory. New and XDG-based installations use `~/.config/rfapps/lock`; an
existing legacy `~/.rfapps` state directory uses `~/.rfapps/lock` only when
`~/.config/rfapps` does not exist. The lock records `operation`, `who`, `when`, and a unique
`lockId`, so a second mutation fails before it reaches Docker or writes deployment state and
reports who owns the active operation.

The lock covers pull, build, deploy, stop, rebuild, delete, prune, apply, rollback, drift import,
`import --adopt`, real backup creation, `state rebuild --rewrite`, `harden --apply`, and apply modes
for plan, update, and reconciliation. Read-only commands, report-only modes, and global `--dry-run` remain lock-free.
`rfapps state export` and report-phase `rfapps state rebuild` are deliberately lock-free as well:
export uses SQLite's online backup API, which is safe under a concurrent writer, and a precautionary
backup must never be blocked by a stuck lock, while the report only reads. Offline
`rfapps backup verify` is also lock-free. Backup creation, managed update, and reconciliation retain
their project-and-Docker-context lifecycle lock as a second safety boundary.

Locks older than ten minutes are reported as stale, but rfapps never removes them automatically:
long-running mutations may legitimately exceed that threshold. Verify that no rfapps CLI or MCP
mutation is still active before using [`force-unlock`](#force-unlock).

### status

Show status of Docker services.

```bash
rfapps status [options]
```

| Option                  | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `-s, --service <name>`  | Target a specific service                               |
| `--services <names>`    | Target multiple services (comma-separated)              |
| `--tag <pattern>`       | Narrow targets by hierarchical tag pattern (repeatable) |
| `-a, --all`             | Show all services (including stopped)                   |
| `--health`              | Show health status                                      |
| `--stats`               | Show resource statistics                                |
| `--logs`                | Show recent logs                                        |
| `-f, --compose <path>`  | Path to Docker Compose file                             |
| `-e, --env-file <path>` | Path to environment file                                |

### health

Check dependency readiness for target services.

```bash
rfapps health [options]
```

`health` uses dependency-aware readiness checks (container state, container health, and TCP probe
reachability). By default it waits until dependencies are ready or timeout; use
`--no-wait-for-ready` for a one-shot snapshot.

| Option                       | Description                                             |
| ---------------------------- | ------------------------------------------------------- |
| `-s, --service <name>`       | Target a specific service                               |
| `--services <names>`         | Target multiple services (comma-separated)              |
| `-g, --group <name>`         | Target a service group                                  |
| `--tag <pattern>`            | Narrow targets by hierarchical tag pattern (repeatable) |
| `--no-sidecars`              | Disable automatic sidecar linking                       |
| `--wait-for-ready`           | Wait for dependencies to become ready                   |
| `--no-wait-for-ready`        | Return immediate dependency readiness snapshot          |
| `--health-timeout <seconds>` | Readiness timeout (defaults to `healthCheck.timeout`)   |
| `-f, --compose <path>`       | Path to Docker Compose file                             |
| `-e, --env-file <path>`      | Path to environment file                                |
| `-p, --profile <name>`       | Docker Compose profile to use                           |

Readiness behavior is directly shaped by service `healthcheck` definitions in `compose.yml`. As
probes become more specific, readiness failures should be higher signal (real startup issues rather
than root-page false positives).

Recommended validation flow after healthcheck changes:

```bash
docker compose config --quiet
rfapps health -g arr-stack --no-wait-for-ready
rfapps health -s sonarr --wait-for-ready --health-timeout 180
```

Tune `healthCheck.timeout`, `healthCheck.interval`, and `healthCheck.retries` only when this
validation shows consistent startup regressions on your host.

### doctor

Run unified read-only diagnostics across configuration, security, runtime status, dependency
readiness, optional image freshness, and rfapps state history.

```bash
rfapps doctor [options]
```

| Option                  | Description                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `-s, --service <name>`  | Target a specific service                                                                |
| `--services <names>`    | Target multiple services (comma-separated)                                               |
| `-g, --group <name>`    | Target a service group                                                                   |
| `--tag <pattern>`       | Narrow targets by hierarchical tag pattern (repeatable)                                  |
| `--no-sidecars`         | Disable automatic sidecar linking                                                        |
| `--check-updates`       | Check registries for newer image versions                                                |
| `--fail-on <severity>`  | Exit when findings meet or exceed severity (`none`, `info`, `warn`, `error`, `critical`) |
| `-f, --compose <path>`  | Path to Docker Compose file                                                              |
| `-e, --env-file <path>` | Path to environment file                                                                 |
| `-p, --profile <name>`  | Docker Compose profile to use                                                            |

`doctor` is read-only by default. It does not mutate containers, write compose or config files, save
plans, or create deployment history. Registry checks are skipped unless `--check-updates` is
provided.

**Examples:**

```bash
rfapps doctor
rfapps doctor -g media-stack
rfapps doctor --check-updates
rfapps doctor --json
rfapps doctor --fail-on warn
```

JSON output is versioned with `schemaVersion: "doctor.v1"`:

```json
{
  "schemaVersion": "doctor.v1",
  "summary": {
    "critical": 0,
    "error": 1,
    "warn": 0,
    "info": 0,
    "total": 1
  },
  "findings": [
    {
      "id": "runtime.unhealthy",
      "severity": "error",
      "category": "runtime",
      "service": "plex",
      "message": "Container is unhealthy",
      "evidence": ["state=running", "health=unhealthy"],
      "suggestedCommand": "rfapps health -s plex --no-wait-for-ready"
    }
  ]
}
```

The default exit threshold is `critical`. Use `--fail-on warn` for stricter CI or `--fail-on none`
for advisory-only diagnostics.

### reconcile

Compare resolved Compose intent with complete Docker runtime evidence and report one deterministic
action for every selected service. The default is read-only; only `--auto-apply` authorizes the
reviewed, same-process reconciliation lifecycle.

```bash
rfapps reconcile [options]
```

| Option                       | Description                                             |
| ---------------------------- | ------------------------------------------------------- |
| `-s, --service <name>`       | Target a specific service                               |
| `--services <names>`         | Target comma-separated services                         |
| `-g, --group <name>`         | Target a service group                                  |
| `--tag <pattern>`            | Narrow targets by hierarchical tag pattern (repeatable) |
| `--no-sidecars`              | Disable automatic sidecar linking                       |
| `--auto-apply`               | Apply the reviewed reconciliation actions               |
| `--show-unchanged`           | Include unchanged services in human/flat output         |
| `--health-timeout <seconds>` | Set the positive readiness timeout per target           |
| `-f, --compose <path>`       | Path to Docker Compose file                             |
| `-e, --env-file <path>`      | Path to environment file                                |
| `-p, --profile <name>`       | Docker Compose profile to use                           |

`--yes` only skips confirmation; it never grants mutation authority. Global `--dry-run` always
prevents mutation, including with `--auto-apply`. Machine-format auto-apply requires both
`--auto-apply` and `--yes` when actionable work exists.

```bash
# Read-only report; reported drift exits zero when observation succeeds
rfapps reconcile -g media-stack

# Full nested reconcile.v1 document
rfapps reconcile --services plex,tautulli --json

# Preview auto-apply intent without mutation
rfapps reconcile -s plex --auto-apply --dry-run

# Confirm and apply exact target-only Compose actions
rfapps reconcile -s plex --auto-apply

# Explicit non-interactive machine mutation
rfapps reconcile -s plex --auto-apply --yes --output yaml
```

The `reconcile.v1` JSON/YAML result is complete, secret-safe, and deterministically ordered. Each
service has one comparison, one `none|create|start|recreate|blocked` action, stable reason codes,
and one terminal outcome. The action fingerprint binds the canonical scope, non-secret authority,
resolved service configuration, exact container identities, drift, policy, and proposed actions.

Auto-apply shares the managed-update lifecycle lock, revalidates reviewed evidence, applies one
service at a time through `up -d --pull never --no-deps` (plus `--force-recreate` only for
recreate), and requires readiness plus fresh zero drift. It never removes orphans, pulls, builds,
renews volumes, starts implicit dependencies, or widens scope. Ambiguous scaled instances and stale
evidence block mutation without a force bypass.

| Exit code | Reconciliation meaning                                         |
| --------- | -------------------------------------------------------------- |
| `0`       | Trustworthy report, no action needed, or fully converged scope |
| `1`       | Observation or reconciliation operation failed                 |
| `2`       | Invalid/unsafe usage or cancellation                           |
| `3`       | Partial, blocked, or residual-drift result                     |

Reconciliation does not save plans, history, generations, or rollback state; pull registry updates;
or run as a daemon or maintenance scheduler. Runtime-to-Compose import remains
`rfapps drift import`. See
[rfapps Reconcile Command](../../docs/features/rfapps-reconcile-command.md) for the full contract.

### import

Adopt running Compose services that were created **outside** rfapps-cli (via `docker compose up`,
legacy `manage.sh`, etc.) into rfapps state tracking, so `history`, `rollback`, `reconcile`, and
`update` work on them. For each adopted service, import records a baseline deployment and its first
immutable generation snapshot, captured from the **running container** (image identity plus a
config snapshot with secret-like environment values masked).

```bash
rfapps import [options]

# Preview: list running services absent from rfapps state and the baselines that would be recorded
rfapps import
rfapps import -g media-stack
rfapps import --json                 # machine-readable import.v1 report

# Record baselines (report-first; --adopt authorizes the state write)
rfapps import --adopt                 # confirms, then records
rfapps import -s plex --adopt --yes   # skip confirmation
```

Import is **report-first**: a bare invocation only previews and writes nothing. `--adopt` authorizes
the write; global `--yes` only skips the confirmation prompt (it never grants write authority), and
global `--dry-run` vetoes the write even with `--adopt`. Machine-format adoption (`--json` /
`--output`) additionally requires `--yes`. A service that already has rfapps history is skipped, so
re-running import is a no-op. During `--adopt`, a running container that cannot be safely inspected
is skipped with no state row written (leaving it importable on retry) and yields exit code `3`; in a
read-only preview it is surfaced as a warning and the report still exits `0`.

Import **never modifies `compose.yml` and never mutates containers** — that is the distinction from
`rfapps drift import`, which rewrites `compose.yml` to match running containers.

| Exit code | Import meaning                                                        |
| --------- | --------------------------------------------------------------------- |
| `0`       | Report completed, nothing to import, or every candidate adopted       |
| `1`       | Observation or state-write operation failed                           |
| `2`       | Invalid/unsafe usage, or adoption was cancelled                       |
| `3`       | Partial adoption: a running candidate could not be inspected, skipped |

### state

Inspect, export, and reconstruct the rfapps state database — the SQLite file that backs `history`,
`rollback`, `update`, and `reconcile`. This is the recovery surface for a state database that is
corrupt, missing, or has silently lost services.

`rfapps state rebuild` is **not** `rfapps rebuild`. `rfapps rebuild` recreates containers;
`rfapps state rebuild` only touches the rfapps state database — it never mutates Docker and never
modifies `compose.yml`.

```bash
rfapps state export [options]
rfapps state rebuild [options]

# Consistent, private copy of the state database (read-only, lock-free)
rfapps state export
rfapps state export -o /secure/backups/state-before-upgrade.db

# Report-first reconstruction: reads only, writes nothing, takes no lock
rfapps state rebuild
rfapps state rebuild --json                 # machine-readable state-rebuild.v1 report

# Replace the state database (a mandatory backup is written first)
rfapps state rebuild --rewrite              # confirms, then replaces
rfapps state rebuild --rewrite --yes        # skip confirmation
rfapps state rebuild --mode runtime-only --confirm-project rfmedia-apps --rewrite
```

| Option                     | Applies To | Description                                                                            |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `-o, --out <path>`         | export     | Backup destination file                                                                |
| `--mode <mode>`            | rebuild    | Reconstruction mode (`salvage` keeps every readable row, `runtime-only` discards them) |
| `--rewrite`                | rebuild    | Replace the state database with the reconstruction                                     |
| `--confirm-project <name>` | rebuild    | Compose project name; required by `--mode runtime-only`                                |
| `--running-only`           | rebuild    | Only reconstruct services whose container is currently running                         |
| `--backup-dir <path>`      | rebuild    | Directory for the mandatory pre-rewrite backup                                         |
| `--show-unchanged`         | rebuild    | Include carried, absent, and orphaned services in the report                           |
| `-f, --compose <path>`     | rebuild    | Path to Docker Compose file                                                            |
| `-e, --env-file <path>`    | rebuild    | Path to environment file                                                               |
| `-p, --profile <name>`     | rebuild    | Docker Compose profile to use                                                          |

`rfapps state export` writes a consistent copy of the state database using SQLite's online backup
API, so the copy is valid even while another rfapps mutation is writing. It never modifies the source
and never acquires the state lock, so a precautionary backup is never blocked by a stuck lock. The
default destination is `<state-dir>/backups/state-<timestamp>.db`, overridable with `-o, --out`, and
global `--dry-run` reports the destination and writes nothing. The artifact is created mode `600`
inside a mode `700` parent; it carries full deployment topology and config snapshots (secret-like
environment values are masked, but treat the file as sensitive). Restore is a plain file copy.

An unreadable source is **not** an export failure. When SQLite cannot parse the source, the raw bytes
are copied instead and the run still exits `0` with `backup.method` set to `"raw-copy"` — a corrupt
state database is exactly what this command exists to preserve. Exit `1` means no artifact was
produced at all (destination already exists, directory not writable, or both copy strategies failed).
Automation that needs a restorable artifact must assert `backup.method == "sqlite-backup"`, not
merely the exit code.

`rfapps state rebuild` is **report-first** reconstruction of the **whole database file** from Docker
runtime and compose declarations. A bare invocation opens the existing database **read-only**,
observes Docker, prints the database that _would_ be built, writes nothing, takes no state lock, and
exits `0`. Only `--rewrite` authorizes the replacement. Global `--yes` only skips the confirmation
prompt and never grants write authority; global `--dry-run` vetoes the rewrite even with `--rewrite`;
machine-format rewrite (`--json` / `--output`) additionally requires `--yes`.

| Mode                | Existing rows                              | Generation numbers                                                | Extra authorization                                                                   |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `salvage` (default) | Carried verbatim, deployment ids preserved | Preserved; baselines added only where there is no carried history | `--rewrite`                                                                           |
| `runtime-only`      | Discarded                                  | Every service restarts at generation #1                           | `--rewrite` **plus** `--confirm-project <name>` matching the resolved Compose project |

Salvage is the safe default: a missing or unreadable source degenerates it into `runtime-only`
automatically, so it is correct for "the file is gone", "the file is damaged", and "the file is fine
but incomplete" alike. `--yes` does not defeat the `--confirm-project` gate.

The pre-rewrite backup is **mandatory and cannot be disabled** — there is no `--no-backup`. If the
backup cannot be written, nothing is rewritten. The strict order is probe → backup → build
replacement → swap. The rebuild never mutates the existing database: it builds a complete
replacement beside it and renames that into place, so any failure leaves the original file
byte-for-byte untouched.

Restore is a single `cp` an operator can perform with a broken CLI:

```bash
rfapps force-unlock                                    # only if a lock is stuck
cp ~/.config/rfapps/backups/state-2026-07-24T18-15-00-000Z.db ~/.config/rfapps/state.db
```

A service that has readable history whose latest generation image id differs from the running
container is reported as `stale` and is **never rewritten**. Appending a fresh baseline there would
record un-reconciled drift as that service's newest generation, so `rollback` to latest would restore
the drift; use `rfapps reconcile` or `rfapps deploy` instead.

`state rebuild` is a whole-file recovery operation, so it deliberately has no `-s, --service`,
`--services`, `-g, --group`, or `--no-sidecars`: a scoped whole-file replacement would silently drop
every out-of-scope service's history. `rfapps import --adopt` is the per-service tool — it is
additive, appends rows in place, skips any service that already has history, and cannot open a
corrupt database. To adopt one untracked service without touching the rest, use
`rfapps import --adopt -s <svc>`.

| Exit code | State rebuild meaning                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `0`       | Report completed, or the database was rewritten with nothing discarded                                        |
| `1`       | Observation, backup, build, or swap failed; the database is unchanged in every case                           |
| `2`       | Invalid or unsafe usage, cancelled, or the rewrite was refused because the planned replacement would be empty |
| `3`       | Partial: the database was rewritten but a container could not be inspected or unreadable rows were discarded  |

See [rfapps State Rebuild](../../docs/features/rfapps-state-rebuild.md) for the full recovery
runbook.

### backup

Create a cold filesystem backup of eligible bind-mounted directories and named volumes, or verify a
published bundle offline.

```bash
rfapps backup [selection options] --destination <directory>
rfapps backup verify <manifest>

# Plan one service without a bundle, pull, lock, stop, or archive
rfapps backup -s plex --destination /mnt/backups --dry-run

# Back up a group after one confirmation
rfapps backup -g media-stack --destination /mnt/backups

# Explicit full-project machine-mode creation
rfapps backup --all --destination /mnt/backups --output json --yes

# Read-only verification without config or Docker
rfapps backup verify /mnt/backups/rfapps-backup-rfmedia-apps-20260729T120000Z/manifest.json
```

| Option                  | Applies To | Description                                               |
| ----------------------- | ---------- | --------------------------------------------------------- |
| `-s, --service <name>`  | create     | Target a specific service                                 |
| `--services <names>`    | create     | Target comma-separated services                           |
| `-g, --group <name>`    | create     | Target a configured service group                         |
| `--tag <pattern>`       | create     | Narrow targets by hierarchical tag pattern (repeatable)   |
| `--all`                 | create     | Explicitly target every service in resolved Compose       |
| `--no-sidecars`         | create     | Disable configured sidecar expansion                      |
| `--destination <dir>`   | create     | Existing directory that will contain the generated bundle |
| `-f, --compose <path>`  | create     | Path to the Docker Compose file                           |
| `-e, --env-file <path>` | create     | Path to the environment file                              |
| `-p, --profile <name>`  | create     | Docker Compose profile                                    |
| `<manifest>`            | verify     | Path to a published bundle's `manifest.json`              |

`--destination` is required. `--all` is mutually exclusive with service/group selectors. In an
interactive terminal using text or table output, no target opens the service selector. An explicit
target or `--all` is required in non-interactive use, in JSON/YAML mode, or with `--yes`.
Machine-format creation requires `--yes` and never prompts. Both creation and verification reject
CSV because their nested recovery and integrity evidence cannot be represented without loss.

The requested scope selects persistent sources, but writer detection uses the **full resolved
Compose project**. rfapps stops every detected running writable consumer of a selected named volume
or equal/ancestor/descendant bind source, re-observes the writer set, streams each source through a
read-only helper, then restarts the exact captured container IDs. This is a cold filesystem backup,
not an application-native database snapshot.

The digest-pinned helper is:

```text
docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1
```

Real creation prepares that exact helper before planning. A cached-helper dry-run may create only a
strictly awaited, sandboxed, read-only probe container so the selected Docker authority can inspect
a bind source; the probe is always removed. Dry-run never pulls the absent helper, creates a bundle,
acquires a lock, stops a service, prompts, or archives. Probe or cleanup failure fails closed.

A successful private bundle uses directory mode `0700`, file mode `0600`, and no-overwrite
publication:

```text
<destination>/rfapps-backup-<project>-<UTC timestamp>/
  artifacts/
    mount-0001.tar.gz
  manifest.json
```

The strict `rfapps-backup.v1` manifest records the requested/resolved/quiesced scopes, all
consumers, skipped sources, helper identity, compressed byte counts, SHA-256 checksums, and
structured manual restore hints. `manifest.json` is published last, after archives are synchronized
and exact-container recovery succeeds. A manifest-less directory is incomplete, not a valid
bundle.

`rfapps backup verify` is read-only and lock-free. It loads no rfapps configuration, invokes no
Docker command, extracts nothing, and reports missing, unexpected, unsafe, non-regular,
size-mismatched, and checksum-mismatched artifacts. SHA-256 proves byte integrity, not authenticity
or signing.

JSON and YAML emit exactly one versioned terminal result:

- creation: `rfapps-backup-result.v1`;
- verification: `rfapps-backup-verify-result.v1`.

| Exit code | Meaning                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `0`       | Plan completed, bundle published and writers recovered, or all verified |
| `1`       | Docker/filesystem/archive/recovery or artifact-integrity failure        |
| `2`       | Invalid/unsafe usage, unsupported manifest, or cancelled approval       |

Version 1 does not automate restore, scheduling, retention, upload, encryption, signing, or
application-native database dumps. Follow each manifest entry's restore hint manually and retain
database-native dump procedures for transactional data.

See [rfapps Native Backup](../../docs/features/rfapps-backup.md) for the full operator contract and
[Backup and Restore Guide](../../docs/guides/backup-restore.md) for complementary database and
disaster-recovery procedures.

### drift

Detect configuration and runtime drift between resolved Compose declarations and Docker state.

```bash
rfapps drift detect [options]
rfapps drift show -s <service> [options]
rfapps drift reconcile [options]
rfapps drift import [options]
```

| Option                  | Applies To    | Description                                             |
| ----------------------- | ------------- | ------------------------------------------------------- |
| `-s, --service <name>`  | all           | Target a specific service                               |
| `--services <names>`    | detect/mutate | Target multiple services (comma-separated)              |
| `-g, --group <name>`    | detect/mutate | Target a service group                                  |
| `--tag <pattern>`       | detect/mutate | Narrow targets by hierarchical tag pattern (repeatable) |
| `--no-sidecars`         | detect/mutate | Disable automatic sidecar linking                       |
| `--show-unchanged`      | detect        | Include unchanged services in text output               |
| `--report-only`         | detect/show   | Keep exit code zero when drift is found                 |
| `--backup`              | import        | Create a `.bak` backup before editing compose           |
| `-f, --compose <path>`  | all           | Path to Docker Compose file                             |
| `-e, --env-file <path>` | all           | Path to environment file                                |
| `-p, --profile <name>`  | all           | Docker Compose profile to use                           |

`detect` and `show` are read-only. The legacy `drift reconcile` route delegates to
`rfapps reconcile --auto-apply`; it selects `create`, `start`, or `recreate` per service and uses
the same confirmation, lock, stale-review, and verification rules. `import` is the distinct
runtime-to-Compose operation. Detect/show machine output is versioned with
`schemaVersion: "1.0.0"`; reconciliation uses `reconcile.v1`. Secret-like environment values are
masked.

**Examples:**

```bash
rfapps drift detect
rfapps drift detect --json
rfapps drift detect --report-only --json
rfapps drift show -s plex
rfapps drift reconcile -s plex --yes
rfapps drift import -s plex --backup --yes
```

### audit

Run a read-only security posture audit over resolved Docker Compose configuration.

```bash
rfapps audit [options]
```

| Option                  | Description                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `-s, --service <name>`  | Target a specific service                                                                |
| `--services <names>`    | Target multiple services (comma-separated)                                               |
| `-g, --group <name>`    | Target a service group                                                                   |
| `--tag <pattern>`       | Narrow targets by hierarchical tag pattern (repeatable)                                  |
| `--no-sidecars`         | Disable automatic sidecar linking                                                        |
| `--fail-on <severity>`  | Exit when findings meet or exceed severity (`none`, `info`, `warn`, `error`, `critical`) |
| `-f, --compose <path>`  | Path to Docker Compose file                                                              |
| `-e, --env-file <path>` | Path to environment file                                                                 |
| `-p, --profile <name>`  | Docker Compose profile to use                                                            |
| `--json`                | Output versioned `audit.v1` JSON                                                         |

Audit checks root-equivalent users, privileged containers, Linux capability additions, missing
capability drops, Docker socket mounts, host networking, service namespace sharing, and missing
CPU/memory limits. It evaluates resolved compose config in memory and does not inspect running
containers, query registries, mutate containers, write compose/config files, save plans, or record
deployment state.

**Examples:**

```bash
rfapps audit
rfapps audit -s traefik
rfapps audit -g media-stack
rfapps audit --json
rfapps audit --fail-on warn
rfapps audit --fail-on none
```

JSON output is versioned with `schemaVersion: "audit.v1"`:

```json
{
  "schemaVersion": "audit.v1",
  "summary": {
    "critical": 1,
    "error": 0,
    "warn": 1,
    "info": 2,
    "total": 4
  },
  "findings": [
    {
      "ruleId": "docker-socket-mounted",
      "category": "host-access",
      "severity": "critical",
      "service": "traefik",
      "message": "Docker socket mounted",
      "evidence": ["volume source or target=/var/run/docker.sock"],
      "remediation": "Avoid mounting `/var/run/docker.sock`; use a scoped proxy or limited integration."
    }
  ]
}
```

The default exit threshold is `critical`. Use `--fail-on none` for always-zero advisory automation
or a stricter threshold for CI. `rfapps doctor` includes audit-derived security findings under its
`security` category, while `rfapps lint` remains the production-readiness and SARIF command.

### harden

Propose, emit, or apply Docker Compose security hardening. `rfapps lint` and `rfapps audit` detect;
`harden` remediates.

```bash
rfapps harden [options]
```

| Option                  | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `-s, --service <name>`  | Target a specific service                               |
| `--services <names>`    | Target multiple services (comma-separated)              |
| `-g, --group <name>`    | Target a service group                                  |
| `--tag <pattern>`       | Narrow targets by hierarchical tag pattern (repeatable) |
| `--no-sidecars`         | Disable automatic sidecar linking                       |
| `--apply`               | Edit `compose.yml` in place (requires confirmation)     |
| `-o, --out <path>`      | Write a compose override fragment to `<path>`           |
| `--include-review`      | Include review-confidence rules in written output       |
| `--rule <ids>`          | Restrict to a comma-separated rule allowlist            |
| `--list-rules`          | Print the rule catalog and exit                         |
| `--no-backup`           | Skip the `compose.yml.bak` copy taken before `--apply`  |
| `--allow-reformat`      | Accept incidental YAML reformatting of untouched lines  |
| `-f, --compose <path>`  | Path to Docker Compose file                             |
| `-e, --env-file <path>` | Path to environment file                                |
| `-p, --profile <name>`  | Docker Compose profile to use                           |
| `--json`                | Output versioned `harden.v1` JSON                       |

**Non-destructive by default.** With no write flag, `harden` resolves Compose configuration, reports
proposed hardening, and prints an editable override fragment. It writes nothing and does not touch
containers, images, or recorded state.

| Flags          | Mode       | Side effects                                                           |
| -------------- | ---------- | ---------------------------------------------------------------------- |
| _(none)_       | `propose`  | Nothing written                                                        |
| `--out <path>` | `override` | Writes the override fragment; refuses to overwrite an existing file    |
| `--apply`      | `apply`    | Rewrites `compose.yml` after a `.bak` copy and one confirmation prompt |

`--out` and `--apply` are mutually exclusive. `--include-review` is legal in every mode; it widens
the proposals eligible for writing, which is what propose mode prints as an override fragment. Global
`--dry-run` suppresses every write in both write modes and still prints the proposals.

**Rule catalog:**

| Rule id                    | Severity | Category     | Confidence | Proposed remediation                              |
| -------------------------- | -------- | ------------ | ---------- | ------------------------------------------------- |
| `harden-no-new-privileges` | `info`   | capabilities | `safe`     | `security_opt += ["no-new-privileges:true"]`      |
| `harden-restart-policy`    | `warn`   | availability | `safe`     | `restart: unless-stopped`                         |
| `harden-log-rotation`      | `warn`   | logging      | `safe`     | full `logging` map with `max-size` and `max-file` |
| `harden-cap-drop-all`      | `info`   | capabilities | `review`   | `cap_drop += ["ALL"]`                             |
| `harden-read-only-rootfs`  | `info`   | filesystem   | `review`   | `read_only: true`                                 |
| `harden-run-as-non-root`   | `warn`   | identity     | `review`   | `user: "${PUID}:${PGID}"`                         |
| `harden-healthcheck`       | `warn`   | health       | `advisory` | none — detection and guidance only                |
| `harden-memory-limit`      | `info`   | limits       | `advisory` | none — detection and guidance only                |
| `harden-cpu-limit`         | `info`   | limits       | `advisory` | none — detection and guidance only                |

`safe` proposals are mechanical and workload-neutral. `review` proposals can break a workload and are
excluded from every write unless `--include-review`. `advisory` proposals are never written: rfapps
will not invent a health probe or a memory/CPU ceiling, because a wrong probe marks a healthy service
unhealthy and a wrong ceiling OOM-kills it.

Sequence-valued patches are unioned with what is already declared, never overwritten, so running
`harden --apply` twice is a no-op and an existing `security_opt` or `cap_drop` entry is never
dropped. Because a Compose override **replaces** a sequence rather than appending to it, the `--out`
fragment always emits the full merged list.

**Refusals.** `--apply` refuses to edit a key that resolves to a YAML alias (for example
`logging: *logging-default`), because the edit would change every service sharing the anchor; the
refusal names `--out` as the alternative. It also refuses when a service is absent from the compose
document or when the existing node is not the kind the operation needs. A refusal is reported and
non-fatal — the detection stands, only the automated write is withheld.

**Reformat acknowledgement.** Writing `compose.yml` means re-serializing the whole document. When
that would change lines `harden` did not target, `--apply` refuses and reports the size of the churn;
pass `--allow-reformat` to accept it, or use `--out` for a non-destructive override. On this
repository the round trip touches exactly one region (6 lines, a wrapped flow sequence in
`authentik-server.healthcheck.test`).

**Examples:**

```bash
# Propose only; writes nothing
rfapps harden

# One rule, non-destructive override fragment
rfapps harden --rule harden-no-new-privileges --out compose.harden.yaml
docker compose -f compose.yml -f compose.harden.yaml up -d

# Apply safe proposals in place after a .bak copy and one confirmation
rfapps harden --apply

# Include review-confidence rules in the write
rfapps harden --apply --include-review

# Catalog and machine output
rfapps harden --list-rules
rfapps harden --json
```

**Exit codes:**

| Code | Meaning           | Description                                                                                                          |
| ---- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success           | Proposals reported, override written, apply completed, or apply cancelled                                            |
| `1`  | Operational error | Compose resolution failed, or the backup/write failed                                                                |
| `2`  | Usage error       | `--apply` with `--out`, `--out` on an existing file, missing `--allow-reformat`, invalid target, profile, or rule id |
| `3`  | Partial success   | `--apply` wrote some patches and refused others                                                                      |

Harden is deliberately **not** a findings gate and has no `--fail-on`: `rfapps lint --fail-on`
already gates this subject matter, and refusing an unsafe edit is correct behaviour rather than an
operational failure. Cancelling at the prompt exits `0`, matching `drift import`.

**Suppressing rules via `.rfapps.yaml`:**

```yaml
harden:
  includeReview: false
  backup: true
  # rules: [harden-no-new-privileges, harden-restart-policy]  # optional allowlist
  ignore:
    - rule: harden-memory-limit
      service: plex # GPU workload; limits are host-dependent
    - rule: harden-run-as-non-root
      service: traefik # binds :80/:443
```

Harden ids are namespaced `harden-*` and have their own catalog; `lint.ignore` does not apply to them
and `rfapps lint` output is unchanged by this command.

`harden --apply` takes the global state mutation lock (operation `harden`) because it writes the same
`compose.yml` that `drift import` writes. Propose mode, `--out`, and global `--dry-run` are
lock-free. Harden is not exposed over the MCP server.

See [rfapps Harden Command](../../docs/features/rfapps-harden-command.md) for the full operator
contract.

### pull

Pull Docker images for services.

```bash
rfapps pull [options]
```

| Option                  | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `-s, --service <name>`  | Target a specific service                               |
| `--services <names>`    | Target multiple services (comma-separated)              |
| `-g, --group <name>`    | Target a service group                                  |
| `--tag <pattern>`       | Narrow targets by hierarchical tag pattern (repeatable) |
| `--no-sidecars`         | Disable automatic sidecar linking                       |
| `-f, --compose <path>`  | Path to Docker Compose file                             |
| `-e, --env-file <path>` | Path to environment file                                |
| `-p, --profile <name>`  | Docker Compose profile to use                           |

### build

Build Docker containers (pull + build).

```bash
rfapps build [options]
```

| Option                  | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `-s, --service <name>`  | Target a specific service                               |
| `--services <names>`    | Target multiple services (comma-separated)              |
| `-g, --group <name>`    | Target a service group                                  |
| `--tag <pattern>`       | Narrow targets by hierarchical tag pattern (repeatable) |
| `--no-sidecars`         | Disable automatic sidecar linking                       |
| `--skip-pull`           | Skip pulling images before building                     |
| `-f, --compose <path>`  | Path to Docker Compose file                             |
| `-e, --env-file <path>` | Path to environment file                                |
| `-p, --profile <name>`  | Docker Compose profile to use                           |

### deploy

Deploy Docker services (pull + start).

```bash
rfapps deploy [options]
```

| Option                       | Description                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| `-s, --service <name>`       | Target a specific service                                          |
| `--services <names>`         | Target multiple services (comma-separated)                         |
| `-g, --group <name>`         | Target a service group                                             |
| `--tag <pattern>`            | Narrow targets by hierarchical tag pattern (repeatable)            |
| `--no-sidecars`              | Disable automatic sidecar linking                                  |
| `--skip-pull`                | Skip pulling images before deploying                               |
| `--force-recreate`           | Force recreate containers even if unchanged                        |
| `--validate-first`           | Run read-only Docker resource conflict validation                  |
| `--scan`                     | Scan resolved images for known vulnerabilities                     |
| `--scanner <name>`           | Scanner backend: `trivy` or `grype` (default: `trivy`)             |
| `--scan-fail-on <severity>`  | Block at or above severity (default: `none`, report only)          |
| `--allow-partial`            | Exit 3 for mixed grouped or multi-service results                  |
| `--parallel`                 | Execute operations in parallel using dependency phases             |
| `--workers <count>`          | Maximum concurrent workers for parallel execution                  |
| `--staged`                   | Roll out the targeted services in dependency-ordered gated batches |
| `--batch-size <count>`       | Services per staged batch                                          |
| `--on-failure <policy>`      | Staged batch failure policy (`halt` or `continue`)                 |
| `--wait-for-ready`           | Wait for dependencies to become ready                              |
| `--no-wait-for-ready`        | Return immediate dependency readiness snapshot                     |
| `--health-timeout <seconds>` | Readiness timeout (defaults to `healthCheck.timeout`)              |
| `-f, --compose <path>`       | Path to Docker Compose file                                        |
| `-e, --env-file <path>`      | Path to environment file                                           |
| `-p, --profile <name>`       | Docker Compose profile to use                                      |

By default, grouped or multi-service deploys exit `1` if any targeted service fails. Pass
`--allow-partial` when CI or automation should treat a mixed outcome as partial success and receive
exit code `3`.

#### Pre-Deploy Conflict Validation

`--validate-first` resolves the effective Compose scope, including sidecars and transitive
`depends_on` or `network_mode: service:` dependencies, then inspects the active Docker authority
for fixed published-port conflicts, objective volume contradictions, and overlapping explicit
network subnets.

```bash
# Validate one service, then continue through the normal deploy flow
rfapps deploy -s web --validate-first

# Validate with fresh read-only evidence but perform no deployment mutation
rfapps deploy -g core-stack --validate-first --dry-run

# Receive one versioned result with validation nested at the top level
rfapps deploy -s web --validate-first --yes --output json
rfapps deploy -s web --validate-first --yes --output yaml
```

Validation returns `passed`, `blocked`, or `inconclusive`. Both non-pass outcomes exit `1` before
confirmation, pull, start, readiness, or state writes. `--yes` does not waive the gate, and
`--allow-partial` applies only after deployment work has a mixed result. CSV is not supported with
this feature; `--output csv --validate-first` is a usage error with exit `2`.

Suggestions are manual guidance only. rfapps never edits Compose, stops unrelated containers, or
creates, removes, or reserves resources. The check uses point-in-time Docker-owned evidence; it
does not cover non-Docker listeners, host-network application sockets, host routes, dynamic
reservations, or application-level volume compatibility.

See [Service Conflict Detection](../../docs/features/service-conflict-detection.md) for the full
scope, status, output, privacy, remote-authority, and troubleshooting contract.

#### Vulnerability Scan Gate

`--scan` resolves the images for the targeted scope and scans them **before** anything is pulled,
recreated, or started. A blocked scan returns before the confirmation prompt and modifies no
containers, images, or recorded state.

```bash
# Advisory report; the deploy proceeds
rfapps deploy -s plex --scan --yes

# Gate at high and above; nothing is pulled or started when it blocks
rfapps deploy -s plex --scan --scan-fail-on high --yes

# Preview the verdict without deploying
rfapps deploy -s plex --scan --scan-fail-on critical --dry-run
```

The gate is fail-closed whenever `--scan-fail-on` is not `none`: a missing scanner binary, a
per-image timeout, a capture overflow, a non-zero scanner exit, and an unparsable report all resolve
to `inconclusive` and block. A scan that "passes" because no scanner is installed would be a silent
fallback, so it is not offered. With the default `--scan-fail-on none` the same situations are
reported loudly and the deploy proceeds with exit `0`.

A blocked or inconclusive gate records a `failed[]` entry named `scan` with code
`VULNERABILITY_THRESHOLD` or `SCAN_INCONCLUSIVE`, logs
`Deploy blocked by vulnerability scan. No containers were modified.`, and exits `1`. `--yes` does not
waive the gate. `--dry-run --scan` always exits `0` and prints the report plus a `would block` line.

The `scan` payload rides on the `DeployResult` envelope for `--output json` and `--output yaml`; it
is stripped for `table` and `csv`. Scanning happens pre-pull by design, so it describes the image
reference Compose resolves rather than a local digest — pin digests in `compose.yml` if you need a
hard guarantee.

See [rfapps Vulnerability Scanning](../../docs/features/rfapps-vulnerability-scanning.md) for the
full failure-mode matrix and suppression contract.

#### Staged Rollout

`--staged` splits a group or multi-service deploy into dependency-ordered batches and gates each
batch on the health of the services it just started. A failing batch stops the rollout before the
remaining services are touched, so a bad image or a broken config change costs one batch instead of
a whole stack.

```bash
# Canary the least critical service first, then widen
rfapps deploy -g infra-stack --staged --batch-size 1 --yes

# Three services at a time
rfapps deploy -g infra-stack --staged --batch-size 3 --yes

# Preview the batch plan without deploying
rfapps deploy -g infra-stack --staged --batch-size 3 --dry-run
```

`--batch-size` defaults to `1`. `--batch-size` and `--on-failure` require `--staged`; passing either
alone is a usage error (exit `2`) reported against the flag you actually typed, as is a
`--batch-size` that is not a positive integer.

**`--staged` requires an explicit service target** — `-s <service>`, `--services a,b,c`, or
`-g <group>`. An untargeted `rfapps deploy --staged` is a usage error (exit `2`), not a staged
deploy of every service: an untargeted deploy hands the whole scope to Compose in one call, so there
is no service list to cut into batches and accepting the flag would silently downgrade to an
ordinary single-pass deploy. In an interactive terminal the multi-select still counts as a target —
pick services there and staging proceeds normally.

**Batching and ordering.** Batches are cut from the same dependency phases `--parallel` uses, so a
service never lands in an earlier batch than something it depends on. Within a phase, members are
ordered by blast radius: non-`core` services first, then services with fewer dependents, then
alphabetically. `core`-profile services (`traefik`, `docktail`, `cloudflared`) go last because they
are depended on through routing labels rather than `depends_on`, so their dependency fan-in
understates their importance. Batch 1 is marked `[canary]`. A batch may span a phase boundary; it
never runs ahead of one.

```text
Staged rollout: 5 batches (batch size 3, on failure: halt)
Worst case 5 batches x 60s gate = up to 5m0s holding the state lock.
  Batch 1 [canary]  phase 0    homarr, ofelia, speedtest-tracker
  Batch 2           phase 0    stirling-pdf, uptime-kuma, forgejo-postgres
  Batch 3           phase 0    cloudflared, docktail, traefik
  Batch 4           phase 1-2  forgejo, forgejo-itcn-runner, forgejo-runner
  Batch 5           phase 2    forgejo-runner-2, forgejo-runner-3
```

**The per-batch gate.** After a batch starts, rfapps polls only that batch's own services until all
of them are ready, one of them fails terminally, or the bound is exhausted. Each poll costs three
Docker calls regardless of batch size. The bound is
`min(--health-timeout, healthCheck.retries × healthCheck.interval)` — 60 seconds with the shipped
defaults. A terminally failed container short-circuits the wait instead of burning the full budget.

**Assurance levels.** A service with a `healthcheck:` block in `compose.yml` is gated on Docker's
own health verdict (`assurance: healthcheck`). The 7 services that declare no healthcheck —
`docktail`, `arr-scripts`, `plex-ratings-sync`, and the four `forgejo-*` runners — can only be
gated on "started and still running", so they must stay running for a bounded 5-second soak before
the batch is allowed to pass (`assurance: running-only`). A crash loop is caught; an application
that comes up unhealthy behind a healthy-looking process is not. Add a `healthcheck:` block to a
service to upgrade its assurance.

**One-shot exemption.** A container that exits `0` under a `no`, empty, or `on-failure` restart
policy is treated as ready with reason `completed`, not as a failure. `plex-ratings-sync` is exactly
this shape: `command: sync`, `restart: on-failure:10`, no healthcheck, driven by an Ofelia schedule.
A container with an `always` or `unless-stopped` restart policy that is `exited` still fails the
gate.

**Time budget and the state lock.** Deploy holds the state mutation lock for the whole rollout, and
that lock goes stale after 10 minutes. The worst case is `batches × per-batch gate`, so a large
group at `--batch-size 1` can outrun the threshold and let another operator's `rfapps force-unlock`
see a live rollout as abandoned. rfapps prints the worst case in the plan block and warns when it
exceeds the threshold; raise `--batch-size` or lower `--health-timeout` in response.

**Escape hatches.**

| Flag                    | Effect                                                                           |
| ----------------------- | -------------------------------------------------------------------------------- |
| `--on-failure continue` | Attempt every batch; still records failures, still exits non-zero                |
| `--no-wait-for-ready`   | Skip the gate entirely; batches become pure sequencing with no halt-on-unhealthy |
| _(no `--staged`)_       | Unchanged single-pass behavior                                                   |

`--no-wait-for-ready` (or `healthCheck.waitForReady: false` in config) removes the safety the
feature exists to provide, so rfapps warns when it is combined with `--staged`.

**Resuming after a halt.** A halted rollout prints an outcome ledger and a resume command scoped to
every service the rollout did not confirm healthy:

```text
HALTED after batch 2 of 5
  healthy:        5  (homarr, ofelia, speedtest-tracker, stirling-pdf, forgejo-postgres)
  unhealthy:      1  (uptime-kuma)
  not attempted:  8  (cloudflared, docktail, traefik, forgejo, forgejo-itcn-runner, forgejo-runner, forgejo-runner-2, forgejo-runner-3)
  Services that were not attempted are still running their previous containers.

  Investigate:  rfapps logs -s uptime-kuma
  Resume:       rfapps deploy --services uptime-kuma,cloudflared,docktail,traefik,forgejo,forgejo-itcn-runner,forgejo-runner,forgejo-runner-2,forgejo-runner-3 --staged --batch-size 3
```

`healthy:` always renders; the `unhealthy:`, `failed to start:`, `dependency skipped:`, and
`not attempted:` buckets appear only when they hold something, and the count column widens to fit
whichever labels were rendered. A service lands in exactly one bucket, and every non-healthy bucket
feeds the resume list — a batch that never got past `docker compose up` produces no unhealthy
services at all, so resuming on `unhealthy:` alone would skip exactly the services that need
attention. `Investigate:` points at the first unhealthy service, or the first that failed to start,
and never at a not-attempted one, whose logs belong to the container it is still running.

Services in later batches are never stopped or recreated — they keep running their previous
containers. The orphan-cleanup pass is skipped entirely on a halt, so the rollout cannot start the
services it just refused to deploy. The resume command deliberately omits `--force-recreate` so
resuming does not widen the blast radius.

The state lock is released when the halted command exits, so there is an **unprotected window**
between a halt and a resume. Nothing prevents another operator or a scheduled job from mutating the
stack in between; re-run `rfapps status` before resuming if that is a real risk in your environment.

**`--staged` always forces dependency-phased execution** over the targeted services, even when
`parallel.enabled` is `false` in config, because batching is defined in terms of the dependency
phases. rfapps logs `--staged uses dependency-phased execution` when it turns phasing on for you.

**Accepted limitations.**

- `rfapps history` cannot report which batch a service belonged to. The batch and failure cause are
  preserved in the recorded `error_message` text, but there is no queryable `run_id` column; adding
  one needs a state-schema version bump.
- Machine output carries `staged.status` but no per-batch `cause` field. The cause is embedded in
  each `failed[].error` string (for example `Batch 2 failed (gate-timeout): …`).
- A failed state-and-health `docker compose ps` read is not reported as degraded telemetry (the
  separate container-name read is). Every batch member then looks `not-running`, so a transient
  Docker daemon hiccup burns the full gate bound and halts the rollout rather than being tolerated.

### Exit Codes

| Code | Meaning           | Description                                                |
| ---- | ----------------- | ---------------------------------------------------------- |
| `0`  | Success           | Validation and the remaining command completed             |
| `1`  | Operational error | Blocked/inconclusive validation or later runtime failure   |
| `2`  | Usage error       | Invalid option, target, path, or unsupported output format |
| `3`  | Partial success   | Post-start mixed result with `--allow-partial`             |

A halted staged rollout is an operational failure, not a success. Every service in a skipped batch
is recorded in `failed[]` with code `STAGE_NOT_ATTEMPTED`, so a halt maps to `1`, or to `3` when
`--allow-partial` is passed and at least one service came up healthy. A canary halt at batch 1 with
zero healthy services exits `1` even with `--allow-partial`, because there is no partial success to
report. `--staged --on-failure continue` uses the same mapping; it changes what is attempted, not
how the outcome is scored.

A blocked or inconclusive `--scan` gate is an operational failure with the same code `1`, raised
before any mutation, so a scan-blocked deploy has no partial result to report and `--allow-partial`
does not change it.

### stop

Stop Docker services without removing them.

```bash
rfapps stop [options]
```

| Option                  | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `-s, --service <name>`  | Target a specific service                               |
| `--services <names>`    | Target multiple services (comma-separated)              |
| `-g, --group <name>`    | Target a service group                                  |
| `--tag <pattern>`       | Narrow targets by hierarchical tag pattern (repeatable) |
| `--no-sidecars`         | Disable automatic sidecar linking                       |
| `-f, --compose <path>`  | Path to Docker Compose file                             |
| `-e, --env-file <path>` | Path to environment file                                |
| `-p, --profile <name>`  | Docker Compose profile to use                           |

### rebuild

Rebuild Docker services with a 4-phase process: stop → pull → build → start.

The rebuild command always uses `--force-recreate` to ensure containers are fully rebuilt.

```bash
rfapps rebuild [options]
```

| Option                       | Description                                             |
| ---------------------------- | ------------------------------------------------------- |
| `-s, --service <name>`       | Target a specific service                               |
| `--services <names>`         | Target multiple services (comma-separated)              |
| `-g, --group <name>`         | Target a service group                                  |
| `--tag <pattern>`            | Narrow targets by hierarchical tag pattern (repeatable) |
| `--no-sidecars`              | Disable automatic sidecar linking                       |
| `--skip-pull`                | Skip pulling images (uses stop → build → start)         |
| `--parallel`                 | Execute operations in parallel using dependency phases  |
| `--workers <count>`          | Maximum concurrent workers for parallel execution       |
| `--wait-for-ready`           | Wait for dependencies to become ready                   |
| `--no-wait-for-ready`        | Return immediate dependency readiness snapshot          |
| `--health-timeout <seconds>` | Readiness timeout (defaults to `healthCheck.timeout`)   |
| `-f, --compose <path>`       | Path to Docker Compose file                             |
| `-e, --env-file <path>`      | Path to environment file                                |
| `-p, --profile <name>`       | Docker Compose profile to use                           |

**Phases:**

1. **Stop** - Stop running containers
2. **Pull** - Pull latest images (skipped with `--skip-pull`)
3. **Build** - Build containers
4. **Start** - Start services with force-recreate and health checks

### delete

Delete Docker services with a 4-phase process: stop → remove → volumes (optional) → prune images
(optional).

```bash
rfapps delete [options]
```

| Option                  | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `-s, --service <name>`  | Target a specific service                               |
| `--services <names>`    | Target multiple services (comma-separated)              |
| `-g, --group <name>`    | Target a service group                                  |
| `--tag <pattern>`       | Narrow targets by hierarchical tag pattern (repeatable) |
| `--no-sidecars`         | Disable automatic sidecar linking                       |
| `--volumes`             | Also remove volumes                                     |
| `--images`              | Also prune unused images                                |
| `-f, --compose <path>`  | Path to Docker Compose file                             |
| `-e, --env-file <path>` | Path to environment file                                |

**Phases:**

1. **Stop** - Stop running containers
2. **Remove** - Remove stopped containers
3. **Volumes** - Remove associated volumes (only with `--volumes`)
4. **Prune** - Prune unused images (only with `--images`)

**Examples:**

```bash
# Basic delete - stop and remove containers
rfapps delete -s uptime-kuma --yes

# Delete with volume cleanup
rfapps delete -s uptime-kuma --volumes --yes

# Full cleanup - containers, volumes, and unused images
rfapps delete -s uptime-kuma --volumes --images --yes

# Delete service group
rfapps delete -g vpn-stack --yes

# Dry-run to preview actions
rfapps delete -s traefik --volumes --dry-run
```

### prune

Prune Docker services with smart image removal. Unlike `delete`, which focuses on container cleanup
with optional image pruning, `prune` always removes service images intelligently - skipping images
shared by other services.

```bash
rfapps prune [options]
```

| Option                  | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `-s, --service <name>`  | Target a specific service                               |
| `--services <names>`    | Target multiple services (comma-separated)              |
| `-g, --group <name>`    | Target a service group                                  |
| `--tag <pattern>`       | Narrow targets by hierarchical tag pattern (repeatable) |
| `--no-sidecars`         | Disable automatic sidecar linking                       |
| `--volumes`             | Also prune Docker volumes                               |
| `--images`              | Also prune dangling images globally                     |
| `-f, --compose <path>`  | Path to Docker Compose file                             |
| `-e, --env-file <path>` | Path to environment file                                |
| `-p, --profile <name>`  | Docker Compose profile to use                           |

**Phases:**

1. **Stop** - Stop running containers
2. **Remove** - Remove stopped containers
3. **Images** - Remove service images (smart removal with sharing detection)
4. **Volumes** - Prune Docker volumes (only with `--volumes`)
5. **Prune Images** - Prune dangling images globally (only with `--images`)

**Smart Image Removal:**

The prune command intelligently handles image removal:

- Identifies which images belong to each service via compose config
- Skips images shared by services NOT being pruned
- Double-checks images aren't in use by running containers
- Reports skipped images with reasons

**Examples:**

```bash
# Basic prune - stop, remove containers, remove service images
rfapps prune -s uptime-kuma --yes

# Prune with volume cleanup
rfapps prune -s uptime-kuma --volumes --yes

# Full cleanup - containers, images, volumes, and dangling images
rfapps prune -s uptime-kuma --volumes --images --yes

# Prune service group
rfapps prune -g vpn-stack --yes

# Dry-run to preview actions
rfapps prune -s traefik --dry-run

# JSON output for scripting
rfapps prune -s uptime-kuma --dry-run --json
```

**Key Difference from Delete:**

| Aspect        | delete                                | prune                                     |
| ------------- | ------------------------------------- | ----------------------------------------- |
| Focus         | Container cleanup                     | Image cleanup                             |
| Image removal | Optional (`--images` prunes dangling) | Always removes service images             |
| Shared images | N/A                                   | Automatically skipped                     |
| Use case      | Quick container teardown              | Full service cleanup with storage reclaim |

### plan

Generate a deployment plan showing what will change before applying. This Terraform-inspired
workflow allows you to preview changes (image updates, environment variables, ports, volumes,
networks) before executing them.

```bash
rfapps plan [options]
```

| Option                      | Description                                               |
| --------------------------- | --------------------------------------------------------- |
| `-s, --service <name>`      | Target a specific service                                 |
| `--services <names>`        | Target multiple services (comma-separated)                |
| `-g, --group <name>`        | Target a service group                                    |
| `--tag <pattern>`           | Narrow targets by hierarchical tag pattern (repeatable)   |
| `--no-sidecars`             | Disable automatic sidecar linking                         |
| `--apply`                   | Immediately apply the plan after generation               |
| `-o, --out <path>`          | Custom plan output path                                   |
| `--show-unchanged`          | Show unchanged services in output                         |
| `--check-updates`           | Check registry for newer image versions                   |
| `--explain`                 | Annotate changes with likely cause and dependency impact  |
| `--scan`                    | Scan resolved images for known vulnerabilities            |
| `--scanner <name>`          | Scanner backend: `trivy` or `grype` (default: `trivy`)    |
| `--scan-fail-on <severity>` | Block at or above severity (default: `none`, report only) |
| `-f, --compose <path>`      | Path to Docker Compose file                               |
| `-e, --env-file <path>`     | Path to environment file                                  |
| `-p, --profile <name>`      | Docker Compose profile to use                             |

**Plan Output:**

The plan shows a detailed diff of what will change:

- **Image changes**: Current vs desired image tags
- **Image updates**: When using `--check-updates`, shows if newer versions are available on the
  registry
- **Environment variables**: Added, removed, or modified (secrets are masked)
- **Port mappings**: Changes to port bindings
- **Volume mounts**: Changes to volume configurations
- **Networks**: Network membership changes

**Change Types:**

- `+` (green) - Service will be created
- `↻` (cyan) - Service will be recreated (image changed)
- `~` (yellow) - Service will be updated (config changed)
- `-` (red) - Service will be deleted
- `=` (gray) - Service unchanged

**Plan Storage:**

Plans are saved to `.rfapps/plans/plan-{timestamp}.json` by default. The plan file includes:

- Unique plan ID
- Creation timestamp
- SHA256 hash of compose.yml (for validation)
- Complete service change details
- Summary statistics

**Examples:**

```bash
# Generate plan for a single service
rfapps plan -s traefik

# Generate plan for a service group
rfapps plan -g media-stack

# Generate plan and apply immediately
rfapps plan -s plex --apply --yes

# Generate plan with custom output path
rfapps plan -s sonarr -o /tmp/my-plan.json

# Show all services including unchanged ones
rfapps plan --show-unchanged

# Check for newer image versions on registry
rfapps plan -s traefik --check-updates

# Generate plan with secrets management
rfapps plan -s traefik --use-dotenvx .env.local

# Check for updates across all services
rfapps plan --check-updates --verbose
```

**Change Origin and Impact:**

`--explain` annotates each changed service with why it changed and what declares a dependency on it.
It is opt-in and read-only: no additional Docker commands are issued, and the plan payload is
byte-identical when the flag is absent.

```bash
# Concise cause and impact annotations
rfapps plan -s plex --explain

# Full reason blocks with evidence
rfapps plan -s plex --explain --verbose
```

Reasons are typed (`trigger`, `provenance`, `advisory`) and carry a confidence of `confirmed` or
`inferred`; inferred reasons always name their alternatives. Impact reports how many services
transitively declare `depends_on` the service and how many of those are running. The global
`-v, --verbose` selects the depth. Annotations are attached at the plan level as `plan.intelligence`,
carried by `--output json` and `--output yaml`. See
[rfapps Plan Intelligence](../../docs/features/rfapps-plan-intelligence.md) for the full reason-code
table, the degradation ladder, and documented limitations.

**Secret Masking:**

Environment variables containing secrets (detected by keywords like `token`, `key`, `secret`,
`password`, etc.) are automatically masked in plan output:

```
+ environment.CF_DNS_API_TOKEN = (secret value)
~ environment.PASSWORD (secret value changed)
+ environment.TZ = "America/New_York"  ← Non-secrets show values
```

**Image Update Detection:**

When using `--check-updates`, the plan compares local image digests with registry digests to detect
available updates without pulling:

```bash
# Check for updates
rfapps plan -s traefik --check-updates

# Output shows:
= unchanged traefik
  image: traefik:v3 (update available)

Summary:
  = 2 unchanged
  ^ 1 update available
```

The update check:

- Uses `docker manifest inspect` to query registries without pulling
- Compares SHA256 digests to detect newer versions
- Works with Docker Hub, GHCR, and private registries
- Skips built images (services using `build` context)
- Runs in parallel for performance

`plan --check-updates` is advisory. It reports registry freshness but does not own the reviewed
pull, target verification, or recovery lifecycle. Use `rfapps update` when an image update should be
planned and applied safely.

**Vulnerability Scanning:**

`--scan` resolves the images `docker compose config` produces for the targeted scope and reports
known vulnerabilities before the plan is applied. It is opt-in and read-only; the report is attached
to the command's output envelope as `scan` and is deliberately **not** embedded in the saved plan, so
`rfapps apply <path>` days later never re-asserts a stale CVE verdict.

```bash
# Advisory report alongside the plan
rfapps plan -g media-stack --scan

# Gate the follow-on apply at high and above
rfapps plan -s plex --scan --scan-fail-on high --apply

# Pick a backend explicitly
rfapps plan -s sonarr --scan --scanner grype

# Machine envelope: { planPath, plan, scan }
rfapps plan -s plex --scan --output json
```

The plan file is still written when the gate blocks — a plan is evidence, not a mutation — but
`--apply` does not run and the command exits `1`. `plan --dry-run` short-circuits before plan
generation, so `plan --dry-run --scan` scans nothing. `--output table` and `--output csv` strip the
nested `scan` payload.

`scan.scanner`, `scan.failOn`, `scan.ignore`, `scan.timeoutMs`, `scan.maxTargets`, and
`scan.concurrency` in `rfapps.config.yaml` supply the defaults; CLI flags win. Suppressions require a
`reason` and honour an optional ISO-8601 `until`, after which the entry stops suppressing and the
report says so:

```yaml
scan:
  scanner: trivy
  failOn: none
  ignore:
    - id: CVE-2024-56171
      service: plex
      reason: "no upstream fix in the linuxserver image; not reachable in this configuration"
      until: "2026-12-31"
```

See [rfapps Vulnerability Scanning](../../docs/features/rfapps-vulnerability-scanning.md) for the
backend prerequisites, skip classification, severity model, JSON shape, and limitations.

### update

Preview and optionally apply verified Docker image updates. The default invocation is read-only
with respect to containers: it detects image identities, displays the result, and saves a private
`update-plan.v1` managed plan.

```bash
rfapps update [options]
```

| Option                       | Description                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| `-s, --service <name>`       | Target a specific service                                           |
| `--services <names>`         | Target multiple services (comma-separated)                          |
| `-g, --group <name>`         | Target a service group                                              |
| `--tag <pattern>`            | Narrow targets by hierarchical tag pattern (repeatable)             |
| `--no-sidecars`              | Disable automatic sidecar linking                                   |
| `--apply`                    | Apply the reviewed plan after confirmation                          |
| `--from-plan <path>`         | Load a saved `update-plan.v1` managed plan                          |
| `-o, --out <path>`           | Write the preview plan or final `update.v1` report to a custom path |
| `--no-restore-on-failure`    | Disable automatic exact-image recovery                              |
| `--health-timeout <seconds>` | Set the target verification timeout                                 |
| `-f, --compose <path>`       | Path to Docker Compose file                                         |
| `-e, --env-file <path>`      | Path to environment file                                            |
| `-p, --profile <name>`       | Docker Compose profile to use                                       |

**Preview-first workflow:**

```bash
# Preview one service; no pull or container recreation occurs
rfapps update -s plex

# Preview a configured group
rfapps update -g media-stack --out .rfapps/plans/media-update.json

# Apply a newly generated plan; prompts once before mutation
rfapps update -s plex --apply

# Apply a previously reviewed plan non-interactively
rfapps update --from-plan .rfapps/plans/media-update.json --apply --yes
```

Preview plans default to `.rfapps/plans/update-{timestamp}.json`. An apply writes a secret-free
`update.v1` report under `.rfapps/reports/` unless `--out` selects another safe path. With
`--from-plan`, do not also pass `--service`, `--services`, `--group`, `--compose`, `--profile`, or
`--no-sidecars`; those flags would change the reviewed scope. Global `--dry-run` keeps `--apply`
preview-only. Machine-format mutation requires both `--apply` and `--yes`.

Example preview output uses only reviewed image metadata and sanitized status text:

```text
Managed image update plan
Plan ID: update-plan-example
  plex: update-available -> registry.example.invalid/media/plex@sha256:2222...
Plan: /srv/rfapps/.rfapps/plans/update-example.json
```

**Apply and recovery behavior:**

1. Acquire the project and Docker-context lifecycle lock.
2. Revalidate the Compose hash, selected scope, Docker context, configured image, current local
   image, platform, and proposed repository digest.
3. Update and verify one service at a time.
4. If verification fails, restore and verify the exact captured daemon-local image by default.

Any identity drift blocks mutation and requires a new preview; there is no force bypass. After a
failed update with a verified restore, later services may continue, but the overall run still exits
`1`. A restore failure stops the remaining lifecycle. `--no-restore-on-failure` is an explicit
reduced-safety mode.

Recovery is image-only under the current Compose configuration. It does not restore or roll back
volumes, application data, databases, configuration, or migrations.

| Exit code | Managed update meaning                                                              |
| --------- | ----------------------------------------------------------------------------------- |
| `0`       | Preview/no-update result is complete, or every applied update verified successfully |
| `1`       | Detection, drift, update, verification, interruption, or recovery failure           |
| `2`       | Invalid arguments, unsafe artifact path, or invalid managed plan                    |

### apply

Apply a saved deployment plan. Validates the plan is still current (compose.yml hasn't changed)
before executing.

This command accepts ordinary deployment plans only. It rejects `intent: "managed-update"`, even
with `--force`. Apply a managed plan through its reviewed lifecycle instead:

```bash
rfapps update --from-plan .rfapps/plans/update-example.json --apply --yes
```

```bash
rfapps apply <plan-file> [options]
```

| Option        | Description                                       |
| ------------- | ------------------------------------------------- |
| `<plan-file>` | Path to plan file (required)                      |
| `--force`     | Apply even if plan is stale (compose.yml changed) |

**Plan Validation:**

Before applying, the command validates:

- Plan file exists and is valid JSON
- Compose file hash matches (prevents applying outdated plans)
- Plan age (warns if older than 24 hours)

**Apply Process:**

1. **Validation** - Check plan validity and compose file hash
2. **Pull Images** - Pull images for services with image changes
3. **Deploy Services** - Start/update services according to plan
4. **Verification** - Verify services are running after deployment

**Examples:**

```bash
# Apply a saved plan
rfapps apply .rfapps/plans/plan-2026-01-20-21-14-29-426.json

# Apply with force (ignore stale plan warning)
rfapps apply plan.json --force --yes

# Apply with JSON output for scripting
rfapps apply plan.json --json
```

**Workflow Example:**

```bash
# Step 1: Generate plan
rfapps plan -s traefik
# Output: Plan saved to .rfapps/plans/plan-2026-01-20-21-14-29-426.json

# Step 2: Review the plan output
# (shows what will change)

# Step 3: Apply the plan
rfapps apply .rfapps/plans/plan-2026-01-20-21-14-29-426.json --yes

# Or combine steps 1 and 3:
rfapps plan -s traefik --apply --yes
```

### history

Show deployment history or generation snapshots for services with filtering options.

```bash
rfapps history [options]
```

| Option                 | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `-s, --service <name>` | Filter by service name                                     |
| `--limit <n>`          | Number of entries to show (default: 10)                    |
| `--since <date>`       | Show entries after this date (ISO 8601 format)             |
| `--action <type>`      | Filter by action type (deploy, rebuild, delete, etc.)      |
| `--generations`        | Show immutable generation snapshots instead of raw history |

**Valid Action Types:**

- `deploy` - Standard deployments
- `rebuild` - Service rebuilds (stop + build + start)
- `delete` - Service deletions
- `prune` - Service prunes with image cleanup
- `apply` - Plan applications
- `rollback` - Rollback operations

**Output Formats:**

The history command supports both table (default) and JSON output:

- Table format shows color-coded status and actions
- JSON format includes all entry details plus total count

**Examples:**

```bash
# Show last 10 deployments (default)
rfapps history

# Show last 20 deployments for traefik
rfapps history -s traefik --limit 20

# Show deploy actions since a specific date
rfapps history --action deploy --since 2024-01-01

# Show all rebuild actions
rfapps history --action rebuild

# Get history as JSON for scripting
rfapps history --json

# Combine filters
rfapps history -s plex --action deploy --limit 5 --json
```

**Sample Output (Table):**

```
Deployment History

    ID  Timestamp            Service               Action      Status        Image Tag
  ----------------------------------------------------------------------------------------------------
    42  2024-01-15 10:30:45  traefik               deploy      success       traefik:v3.0
    41  2024-01-14 09:15:22  plex                  rebuild     success       plexinc/pms-docker:latest
    40  2024-01-13 14:00:00  sonarr                deploy      success       linuxserver/sonarr:latest

Showing 3 entries
```

**Sample Output (JSON):**

```json
{
  "entries": [
    {
      "id": 42,
      "timestamp": "2024-01-15T10:30:45.000Z",
      "service": "traefik",
      "action": "deploy",
      "status": "success",
      "imageTag": "traefik:v3.0",
      "configSnapshot": "{...}"
    }
  ],
  "totalCount": 42,
  "filters": {
    "service": null,
    "action": null,
    "since": null,
    "limit": 10
  }
}
```

**Generation Snapshots (`--generations`):**

Every successful deploy-like action (deploy, rebuild, apply, rollback) appends an immutable,
per-service numbered generation snapshot — Nix-style generational state. Unlike raw history,
generations are append-only restore targets that are never updated or deleted, and only successful
configurations appear in the list.

```bash
# Show last 10 generations across all services
rfapps history --generations

# Show generations for a single service
rfapps history --generations -s traefik

# Generations as JSON for scripting
rfapps history --generations -s traefik --output json
```

Sample output:

```
Generations

    Gen  Timestamp            Service   Action    Deploy  Image Tag
  ------------------------------------------------------------------
     #2  2026-05-10 10:00:00  traefik   rebuild        2  traefik:v3.1
     #1  2026-05-01 10:00:00  traefik   deploy         1  traefik:v3.0

Restore with: rfapps rollback -s <service> --to-generation <n>
```

The `--action` and `--since` filters apply to raw history only and cannot be combined with
`--generations` (use `rollback --to-time` to restore by time).

### rollback

Rollback a service to a previous deployment, or restore it to a specific generation snapshot.

```bash
rfapps rollback -s <service> [options]
```

| Option                  | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `-s, --service <name>`  | Service to rollback (required)                           |
| `--steps <n>`           | Number of deployments to rollback (default: 1)           |
| `--to-deployment <id>`  | Rollback to specific deployment ID                       |
| `--to-generation <n>`   | Restore to a specific generation number                  |
| `--to-time <timestamp>` | Restore to the generation active at this time (ISO 8601) |
| `--force`               | Skip validation warnings                                 |

**How It Works:**

1. **Find Target** - Locates the restore target by steps back, deployment ID, generation number, or
   time
2. **Validate** - Ensures target deployment was successful and matches the service
3. **Pull Image** - Pulls the target image if not available locally
4. **Recreate** - Recreates the service (and sidecars) with force-recreate
5. **Record** - Records the rollback action in the state database (which appends a new generation
   snapshot)

**Restore Scope:**

Rollback restores the service image only — service config comes from the current compose file.
Volumes and databases are never rolled back — application data is untouched.

**Target Selection (mutually exclusive):**

- `--steps N` - Roll back N successful deployments (default: 1 = previous deployment)
- `--to-deployment ID` - Roll back to a specific deployment by its ID (from `rfapps history`)
- `--to-generation N` - Restore to a specific generation number (from
  `rfapps history --generations`)
- `--to-time TIMESTAMP` - Restore to the generation that was active at the given time

**Validation:**

- Only successful deployments can be rollback targets
- Service name must match the target deployment
- Warns when rolling back more than 5 steps (use `--force` to skip)
- Warns when recreating a previously deleted service (use `--force` to proceed)

**Sidecar Handling:**

Sidecars are automatically included in rollback operations. For example, rolling back `plex` will
also recreate expanded sidecar pairs when sidecar linking is enabled in config.

**Examples:**

```bash
# Rollback traefik to the previous deployment
rfapps rollback -s traefik --yes

# Rollback plex 3 deployments back
rfapps rollback -s plex --steps 3 --yes

# Rollback to a specific deployment ID (from history)
rfapps rollback -s sonarr --to-deployment 42 --yes

# Restore to a specific generation (from history --generations)
rfapps rollback -s traefik --to-generation 5 --yes

# Restore to whatever was running at a point in time
rfapps rollback -s traefik --to-time 2026-06-01T00:00:00Z --yes

# Preview rollback without executing
rfapps rollback -s traefik --dry-run

# Force rollback, skipping validation warnings
rfapps rollback -s radarr --steps 5 --force --yes

# Rollback with JSON output for scripting
rfapps rollback -s bazarr --json --yes
```

**Workflow Example:**

```bash
# Step 1: Check deployment history
rfapps history -s traefik --limit 5

# Output shows:
#   ID  Timestamp            Service   Action   Status    Image Tag
#   45  2024-01-15 10:30:45  traefik   deploy   success   traefik:v3.1
#   42  2024-01-14 09:15:22  traefik   deploy   success   traefik:v3.0
#   38  2024-01-13 14:00:00  traefik   deploy   success   traefik:v2.11

# Step 2: Preview rollback to previous version
rfapps rollback -s traefik --dry-run

# Output shows:
#   Rollback Target:
#     Service: traefik
#     Target Deployment: #42
#     Timestamp: 2024-01-14T09:15:22.000Z
#     Original Action: deploy
#     Image: traefik:v3.0
#
#   [DRY RUN] Would: rollback traefik to deployment #42

# Step 3: Execute rollback
rfapps rollback -s traefik --yes

# Step 4: Verify rollback was recorded
rfapps history -s traefik --limit 1

# Output shows:
#   ID  Timestamp            Service   Action     Status    Image Tag
#   46  2024-01-15 11:00:00  traefik   rollback   success   traefik:v3.0
```

**Rollback a Deleted Service:**

If a service was previously deleted or pruned, rollback can recreate it:

```bash
# Service was deleted
rfapps delete -s uptime-kuma --yes

# Later, restore it from history
rfapps rollback -s uptime-kuma --force --yes
```

### init

Generate configuration file from compose.yml.

```bash
rfapps init [options]
```

| Option         | Description                             |
| -------------- | --------------------------------------- |
| `-g, --global` | Write to global config (~/.rfapps.yaml) |
| `--json`       | Generate JSON config instead of YAML    |
| `-f, --force`  | Overwrite existing config file          |
| `--dry-run`    | Preview config without writing          |

**What it does:**

- Parses your `compose.yml` to discover services
- Auto-detects sidecar mappings (services ending in `-ts`)
- Assigns services to profiles based on naming patterns
- Creates predefined service groups (media-stack, arr-stack, etc.)
- Generates a complete configuration file

**Examples:**

```bash
# Generate project-specific config
rfapps init

# Generate global config
rfapps init --global

# Preview generated config
rfapps init --dry-run

# Force overwrite existing config
rfapps init --force

# Generate JSON format
rfapps init --json
```

**Auto-detection Logic:**

The init command intelligently assigns services to profiles:

- `traefik`, `authentik*` → `core`
- `uptime-kuma`, `homarr`, `stirlingpdf` → `infrastructure`
- `sabnzbd`, `prowlarr`, `nzbget`, `slskd` → `downloads`
- `sonarr`, `radarr`, `lidarr`, `bazarr` → `arr-stack`
- `plex`, `tautulli`, `plexseerr`, `jellyseerr` → `media`
- `immich*` → `photos`

After generation, review and customize the file to match your setup.

### lint

Check resolved Docker Compose configuration for production-readiness issues (restart policies,
health checks, log rotation, resource limits, security hardening). Optionally compare running
containers for runtime drift.

```bash
rfapps lint [options]
```

| Option                  | Description                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `-s, --service <name>`  | Target a specific service                                                                                 |
| `--services <names>`    | Target multiple services (comma-separated)                                                                |
| `-g, --group <name>`    | Target a service group                                                                                    |
| `--tag <pattern>`       | Narrow targets by hierarchical tag pattern (repeatable)                                                   |
| `--no-sidecars`         | Disable automatic sidecar linking                                                                         |
| `-f, --compose <path>`  | Path to Docker Compose file                                                                               |
| `-e, --env-file <path>` | Path to environment file                                                                                  |
| `-p, --profile <name>`  | Docker Compose profile to use                                                                             |
| `--json`                | Output findings in JSON format                                                                            |
| `--sarif`               | Output findings in SARIF 2.1.0 format (CI integrations)                                                   |
| `--runtime`             | Include runtime drift findings from running containers                                                    |
| `--list-rules`          | List available lint rules and exit                                                                        |
| `--fail-on <severity>`  | Exit with error when findings meet or exceed severity (`none`, `info`, `warn`, `error`; default: `error`) |

**Examples:**

```bash
# Lint all services in the resolved compose config
rfapps lint

# Lint a service group
rfapps lint -g media-stack

# List built-in rules (id, severity, rationale)
rfapps lint --list-rules

# Fail on warnings (stricter CI gate)
rfapps lint --fail-on warn

# Include runtime container drift
rfapps lint --runtime -s traefik

# JSON output for automation
rfapps lint --json
```

**Exit codes:**

| Code | Meaning           | Description                                                                |
| ---- | ----------------- | -------------------------------------------------------------------------- |
| `0`  | Success           | No findings at or above `--fail-on` threshold (default: `error` and above) |
| `1`  | Operational error | Findings meet or exceed `--fail-on`, or Docker/runtime inspection failed   |
| `2`  | Usage error       | Invalid arguments, unknown service/group, or invalid `lint.ignore` rule id |

With the default `--fail-on error`, `warn` and `info` findings are reported but do not cause a
non-zero exit. Use `--fail-on warn` or `--fail-on info` for stricter CI gates, or `--fail-on none`
to always exit `0` while still printing findings.

**Finding groups and context notes:**

Text output splits findings into two advisory groups:

| Group          | Severities      | Meaning                                                          |
| -------------- | --------------- | ---------------------------------------------------------------- |
| `recommended`  | `error`, `warn` | Operational gaps (restart, healthcheck, logs, privileged mode)   |
| `review_first` | `info`          | Optional security/resource hardening — review workload fit first |

When `review_first` findings exist, a banner reminds you that info-level rules may not suit every
workload. Optional `contextNote` lines explain compose signals (writable bind mounts, `cap_add`,
devices, root user, database/cache images) without changing rule behavior or exit codes.

`--json` includes `group` and `contextNote` on each finding. `--sarif` maps `group` to
`result.properties.tags` and `contextNote` to `result.properties.contextNote`.

**Suppressing findings via `.rfapps.yaml`:**

Configure `lint.ignore` to suppress specific rule/service combinations. Ignored findings are omitted
from output and excluded from exit-code calculation.

```yaml
lint:
  ignore:
    # Suppress a rule for all services
    - rule: read-only-rootfs

    # Suppress a rule for one service
    - rule: resource-limits-missing
      service: plex

    # Suppress all rules for a service
    - rule: "*"
      service: legacy-helper
```

The shipped `rfapps.config.yaml` exempts `plex` from `resource-limits-missing` because GPU
transcoding memory limits are host-dependent. Override or remove those entries in a project-local
`.rfapps.yaml` if you want stricter checks.

### tag

Inspect the hierarchical service tag taxonomy. Every subcommand is **read-only**: none writes
`compose.yml`, none writes configuration, none writes the state database, and none takes the global
state lock.

```bash
rfapps tag list    [--tree] [-f <compose>] [-e <env-file>] [-p <profile>] [--json]
rfapps tag show    -s <service> | --services <names>   [-f] [-e] [-p] [--json]
rfapps tag suggest [-s <service>] [--services <names>] [-g <group>]
                   [--rule <ids>] [--list-rules] [--include-tagged]
                   [-o|--out <path>] [-f] [-e] [-p] [--json]
```

| Option                  | Applies To    | Description                                              |
| ----------------------- | ------------- | -------------------------------------------------------- |
| `--tree`                | list          | Render the taxonomy as an indented tree                  |
| `-s, --service <name>`  | show, suggest | Target a specific service                                |
| `--services <names>`    | show, suggest | Target comma-separated services                          |
| `-g, --group <name>`    | suggest       | Target a configured service group                        |
| `--rule <ids>`          | suggest       | Restrict inference to a comma-separated rule allowlist   |
| `--list-rules`          | suggest       | Print the inference rule catalog and exit                |
| `--include-tagged`      | suggest       | Include services whose proposed tags are already present |
| `-o, --out <path>`      | suggest       | Write the YAML fragment to `<path>` instead of stdout    |
| `-f, --compose <path>`  | all           | Path to Docker Compose file                              |
| `-e, --env-file <path>` | all           | Path to environment file                                 |
| `-p, --profile <name>`  | all           | Docker Compose profile to use                            |
| `--json`                | all           | Emit the versioned `tags.v1` result as JSON              |

```bash
rfapps tag list                            # every effective tag and its services
rfapps tag list --tree                     # indented hierarchy
rfapps tag show -s plex                    # declared vs effective tags
rfapps tag suggest --list-rules            # inference rule catalog
rfapps tag suggest --out tags.yaml         # paste-ready fragment; refuses to clobber
```

Tags are authored by hand in the `tags:` section of `rfapps.config.yaml`; `rfapps tag suggest` only
proposes a block to paste there. A service tagged `media/automation/tv` implicitly carries
`media/automation` and `media`, so store leaf paths only.

Selection with tags happens on the operating commands through the repeatable `--tag <pattern>` flag,
which **narrows** an existing selection by intersection:

```bash
rfapps plan   --tag media                             # the whole media subtree
rfapps deploy --tag "media/streaming" --yes
rfapps pull   --tag "media/**,photos/**"              # OR within one flag
rfapps stop   --tag "**" --tag "!media/**"            # AND across flags
rfapps deploy -g arr-stack --tag "media/automation" --yes
```

A `--tag` pattern that matches nothing exits `2` rather than falling through to "every service".
Trailing `/*` is rejected — write `infrastructure` or `infrastructure/**` for a whole subtree. See
[rfapps Tag Selector](../../docs/features/rfapps-tag-selector.md) for the full contract.

### completion

Generate shell completion scripts.

```bash
rfapps completion [shell] [options]
```

| Option                | Description                                      |
| --------------------- | ------------------------------------------------ |
| `[shell]`             | Target shell (bash, zsh, fish)                   |
| `-s, --shell <shell>` | Target shell (alternative to argument)           |
| `--install`           | Install completion script to shell configuration |
| `--force`             | Skip confirmation prompts during installation    |

### force-unlock

Dangerously remove the global state lock after verifying that no rfapps mutation is still active.
This command displays the current operation, owner, timestamp, and lock status when the metadata is
valid.

```bash
rfapps force-unlock
rfapps force-unlock --yes
```

Interactive text mode requires confirmation. Global `--yes` skips the prompt; machine output such
as `--json` or `--output yaml` requires `--yes` for actual removal. Global `--dry-run` reports the
lock without prompting or removing it. The lock path is a private directory containing one
owner-token file named by the metadata `lockId`. Removal verifies and deletes only that exact token,
then removes the directory non-recursively; a changed or replacement lock fails closed.

### mcp

Run the rfapps MCP server over stdio.

```bash
rfapps mcp
```

The MCP server supports `initialize`, `tools/list`, and `tools/call` with the rfapps tool catalog.
See [`docs/features/rfapps-mcp-server.md`](../../docs/features/rfapps-mcp-server.md) for protocol
details, tool names, argument conventions, and response/error envelopes.

## Global Options

These options are available for all commands:

| Option                 | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `--dry-run`            | Preview actions without executing                   |
| `--debug`              | Enable debug output                                 |
| `--json`               | Output in JSON format (shorthand for --output json) |
| `--output <format>`    | Output format: json, yaml, csv, table, text         |
| `-v, --verbose`        | Show detailed output                                |
| `-y, --yes`            | Skip confirmation prompts                           |
| `--use-dotenvx <file>` | Use dotenvx for secrets injection                   |
| `--use-op <file>`      | Use 1Password CLI for secrets injection             |
| `--help`               | Show help for command                               |
| `--version`            | Show CLI version                                    |

## Secrets Integration

The CLI supports secrets injection using dotenvx or 1Password CLI. This allows you to manage
sensitive environment variables securely while preserving shell completion functionality.

### Using dotenvx

Inject secrets from an encrypted environment file:

```bash
# Deploy with dotenvx secrets
rfapps deploy --use-dotenvx .env.local --yes

# Rebuild with secrets injection
rfapps rebuild -s traefik --use-dotenvx .env.local --yes
```

### Using 1Password CLI

Inject secrets from 1Password:

```bash
# Deploy with 1Password secrets
rfapps deploy --use-op .env --yes

# Build with secrets injection
rfapps build -g media-stack --use-op .env.prod --yes
```

### Comparison with External Wrapping

**Without secrets integration (loses completions):**

```bash
dotenvx run -f .env.local -- rfapps deploy --service=traefik
```

**With secrets integration (preserves completions):**

```bash
rfapps deploy --service=traefik --use-dotenvx .env.local
```

### Notes

- Only one secrets tool can be used at a time (`--use-dotenvx` and `--use-op` are mutually
  exclusive)
- The CLI validates that the specified tool is installed before execution
- The CLI validates that the environment file exists before execution
- All Docker commands are wrapped with the secrets tool when specified

## Error Messages

rfapps provides structured error messages with actionable guidance to help you recover from common
mistakes quickly.

**Key features:**

- **Fuzzy-match suggestions** -- Misspelled service, group, or profile names trigger "Did you mean?"
  suggestions using Levenshtein distance matching
- **Actionable suggestions** -- Each error includes specific steps to resolve the issue
- **Machine-readable errors** -- Structured error output in JSON/YAML/CSV when using `--output` or
  `--json`
- **Debug details** -- Extended diagnostic information with `--debug`

**Examples:**

```bash
# Misspelled service name
$ rfapps deploy -s plx --yes
# Error: Service 'plx' not found
# Suggestions:
#   - Did you mean 'plex'?
#   - Run with --debug for more details

# Misspelled group name
$ rfapps deploy -g media-stck --yes
# Error: Unknown service group: 'media-stck'
# Suggestions:
#   - Did you mean 'media-stack'?
#   - Available groups: vpn-stack, download-stack, arr-stack, media-stack, ...
#   - Run with --debug for more details

# Missing configuration
$ rfapps deploy -s plex --yes
# Error: Configuration file not found
# Suggestions:
#   - Run 'rfapps init' to create a configuration file
#   - Run with --debug for more details
```

For the full error class reference and formatting pipeline details, see
[Error Handling](../../docs/features/error-handling.md).

## Interactive Service Selection

When running commands without service targeting flags (`-s`, `--services`, or `-g`) in a terminal
environment, an interactive multi-select menu appears. This allows you to visually select which
services to operate on.

### Menu Features

- **Status indicators**: Services show their current state
  - `✓` (green) - Running and healthy
  - `!` (yellow) - Running but unhealthy
  - `-` (dim) - Stopped/exited
  - `○` (dim) - Created but never started
- **Type-ahead filtering**: Start typing to filter the service list
- **Multi-select**: Use spacebar to toggle service selection
- **Confirm**: Press Enter to confirm selection
- **Cancel**: Press Escape or Ctrl+C to cancel

### When Interactive Selection Triggers

The interactive menu appears when ALL of the following are true:

- Running in a TTY environment (terminal)
- No service targeting flags provided (`-s`, `--services`, `-g`)
- `--yes` flag is not set
- `--json` flag is not set

### Bypassing Interactive Selection

Use any of these methods to skip the interactive menu:

| Method              | Description                                |
| ------------------- | ------------------------------------------ |
| `-s <service>`      | Target a specific service                  |
| `--services <list>` | Target multiple services (comma-separated) |
| `-g <group>`        | Target a service group                     |
| `--yes`             | Auto-confirm, operates on all services     |
| `--json`            | JSON output mode, operates on all services |
| Non-TTY environment | Pipes/scripts default to all services      |

### Examples

```bash
# Interactive selection - shows menu to pick services
rfapps deploy

# Interactive selection for rebuild
rfapps rebuild

# Skips interactive - deploys only traefik
rfapps deploy -s traefik

# Skips interactive - deploys specified services
rfapps deploy --services plex,sonarr,radarr

# Skips interactive - deploys entire group
rfapps deploy -g media-stack

# Skips interactive - deploys all services without prompts
rfapps deploy --yes

# Skips interactive - JSON output for scripting
rfapps deploy --json
```

## Service Targeting

### Single Service

Target a specific service:

```bash
rfapps deploy -s plex --yes
rfapps rebuild -s sonarr --yes
```

### Multiple Services

Target multiple services (comma-separated):

```bash
rfapps deploy --services plex,sonarr,radarr --yes
rfapps rebuild --services bazarr,prowlarr --yes
```

### Service Groups

Target predefined service groups:

```bash
rfapps deploy -g media-stack --yes
rfapps rebuild -g arr-stack --yes
```

### Tag Patterns

`--tag <pattern>` **narrows** the selection above by hierarchical tag. It is repeatable, patterns
inside one flag are OR-ed with commas, and repeated flags are AND-ed:

```bash
rfapps deploy --tag "media/streaming" --yes          # subtree selection
rfapps pull --tag "media/**,photos/**"               # OR within one flag
rfapps stop --tag "**" --tag "!media/**"             # AND across flags
rfapps deploy -g arr-stack --tag "media/automation" --yes   # intersection with -g
```

A pattern that matches nothing exits `2` instead of falling through to "every service", so a typo
can never widen the blast radius. Trailing `/*` is rejected — a bare segment already means the whole
subtree. See [rfapps Tag Selector](../../docs/features/rfapps-tag-selector.md).

### Sidecar Linking

When `sidecars.enabled: true` (disabled in this repo — see `rfapps.config.yaml`), the CLI
automatically expands service targets to include mapped sidecar pairs. Use `--no-sidecars` to
opt out per command:

```bash
# Deploys plex only (sidecars.enabled: false in this repo)
rfapps deploy -s plex --yes

# Explicit opt-out (equivalent when sidecars are already disabled)
rfapps deploy -s plex --no-sidecars --yes
```

### Force Recreate

When `sidecars.enabled: true` and sidecars are detected, `--force-recreate` is automatically
enabled to prevent stale network state. Use it manually for any deployment that requires it:

```bash
# Manually enable force-recreate
rfapps deploy --force-recreate --yes

# Disable sidecar expansion (also disables auto force-recreate when sidecars are enabled)
rfapps deploy -s plex --no-sidecars --yes
```

### Parallel Operations

The `--parallel` flag enables dependency-aware parallel execution for deploy and rebuild commands.
Services are topologically sorted into phases based on `depends_on` and `network_mode` declarations
in `compose.yml`, then executed concurrently within each phase up to a configurable worker limit.

Phase ordering ensures that a service's dependencies are fully started before the service itself
begins. When sidecars are enabled, paired services are treated as atomic units and always land in the
same phase.

```bash
# Parallel deploy all services
rfapps deploy --all --parallel --yes

# Parallel deploy with 8 concurrent workers
rfapps deploy --all --parallel --workers 8 --yes

# Parallel rebuild
rfapps rebuild -g media-stack --parallel --yes

# Preview the execution plan without running
rfapps deploy --all --parallel --dry-run
```

In parallel mode, Docker output is captured rather than streamed to avoid interleaved output.
Progress is displayed using listr2 concurrent task spinners instead.

The default worker count is 4, which is conservative for SSH-based remote Docker contexts. Increase
with `--workers` or set `parallel.workers` in config for local Docker environments. Enable parallel
by default with the `parallel.enabled` config option.

## Service Groups

Predefined groups for common operations:

| Group            | Services                                                                           |
| ---------------- | ---------------------------------------------------------------------------------- |
| `vpn-stack`      | slskd                                                                              |
| `download-stack` | unpackerr, autobrr, sabnzbd, slskd, nzbget                                         |
| `arr-stack`      | sonarr, radarr, lidarr, bazarr, prowlarr                                           |
| `media-stack`    | plex, jellyfin, sonarr, radarr, lidarr, bazarr                                     |
| `auth-stack`     | authentik-server, authentik-worker, authentik-db, authentik-redis, authentik-media |
| `immich-stack`   | immich-server, immich-ml, immich-redis, immich-postgres                            |

**Note:** This repo ships with `sidecars.enabled: false` in `rfapps.config.yaml`. Tailnet exposure
is handled by `docktail` and `docktail.service.*` labels — there are no `*-ts` sidecar containers.
The sidecar linking feature remains available for custom forks that set `sidecars.enabled: true`.

## Examples

### Basic Operations

```bash
# Check status of all running services
rfapps status

# Check status including stopped services
rfapps status --all

# Pull latest images for all services
rfapps pull --yes

# Deploy all services
rfapps deploy --yes

# Stop all services
rfapps stop --yes
```

### Service-Specific Operations

```bash
# Deploy only Plex
rfapps deploy -s plex --yes

# Rebuild Sonarr and Radarr
rfapps rebuild --services sonarr,radarr --yes

# Delete Overseerr with volume cleanup
rfapps delete -s plexseerr --volumes --yes
```

### Group Operations

```bash
# Deploy the entire media stack
rfapps deploy -g media-stack --yes

# Rebuild all arr services
rfapps rebuild -g arr-stack --yes

# Pull updates for download clients
rfapps pull -g download-stack --yes
```

### Plan/Apply Workflow

```bash
# Preview changes before deploying
rfapps plan -s traefik

# Check for newer image versions on registry
rfapps plan -s traefik --check-updates

# Annotate changes with likely cause and dependency impact
rfapps plan -s plex --explain

# Apply a saved plan
rfapps apply .rfapps/plans/plan-2026-01-20-21-14-29-426.json --yes

# Generate and apply in one command
rfapps plan -s plex --apply --yes

# Plan for multiple services
rfapps plan --services sonarr,radarr,lidarr

# Plan with secrets management
rfapps plan -g media-stack --use-dotenvx .env.local

# Check for updates across all services
rfapps plan --check-updates --verbose
```

### Deployment History and Rollback

```bash
# View recent deployment history
rfapps history

# Filter history by service
rfapps history -s traefik --limit 5

# Filter by action type
rfapps history --action deploy

# Filter by date range
rfapps history --since 2024-01-01

# Get history as JSON for automation
rfapps history -s plex --json

# Rollback to previous deployment
rfapps rollback -s traefik --yes

# Rollback multiple steps
rfapps rollback -s plex --steps 3 --yes

# Rollback to specific deployment ID
rfapps rollback -s sonarr --to-deployment 42 --yes

# Preview rollback without executing
rfapps rollback -s radarr --dry-run

# Force rollback (skip warnings)
rfapps rollback -s bazarr --force --yes
```

### Scripting and Automation

```bash
# Get status as JSON for parsing
rfapps status --json | jq '.services'

# Dry run to preview actions
rfapps deploy -g media-stack --dry-run

# Non-interactive deployment
rfapps deploy --yes

# Deploy with secrets injection via dotenvx
rfapps deploy --use-dotenvx .env.local --yes

# Deploy with secrets injection via 1Password CLI
rfapps deploy --use-op .env --yes

# Generate plan as JSON for automation
rfapps plan -s traefik --json > plan.json

# Apply plan with JSON output
rfapps apply plan.json --json
```

### Custom Compose Files

```bash
# Use custom compose file
rfapps deploy -f /path/to/compose.yml --yes

# Use custom environment file
rfapps deploy -e /path/to/.env.prod --yes

# Use specific profile
rfapps deploy -p core --yes
```

## Shell Completion

### Generate and View Script

```bash
# Print bash completion script
rfapps completion bash

# Print zsh completion script
rfapps completion zsh

# Print fish completion script
rfapps completion fish
```

### Install Completion

```bash
# Install bash completion
rfapps completion bash --install

# Install zsh completion
rfapps completion zsh --install

# Install fish completion
rfapps completion fish --install
```

### Manual Installation

**Bash:**

```bash
rfapps completion bash > ~/.bash_completion.d/rfapps
echo 'source ~/.bash_completion.d/rfapps' >> ~/.bashrc
```

**Zsh:**

```bash
rfapps completion zsh > ~/.zfunc/_rfapps
echo 'fpath=(~/.zfunc $fpath); autoload -Uz compinit && compinit' >> ~/.zshrc
```

**Fish:**

```bash
rfapps completion fish > ~/.config/fish/completions/rfapps.fish
```

## Environment Variables

| Variable       | Description                           |
| -------------- | ------------------------------------- |
| `RFAPPS_DEBUG` | Enable debug mode (same as `--debug`) |

## Docker Compose Profiles

The CLI supports Docker Compose profiles for service categorization:

| Profile          | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `core`           | Essential infrastructure (traefik, authentik)         |
| `infrastructure` | Management tools (uptime-kuma, homarr, stirlingpdf)   |
| `downloads`      | Download clients (sabnzbd, prowlarr, nzbget, slskd)   |
| `arr-stack`      | Automation services (sonarr, radarr, lidarr, bazarr)  |
| `media`          | Media servers (plex, tautulli, plexseerr, jellyseerr) |
| `photos`         | Photo management (immich services)                    |
| `all`            | All services                                          |

## Development

### Build

Compile TypeScript to JavaScript:

```bash
npm run build
```

### Development Mode

Run directly with tsx (no build required):

```bash
npm run dev
```

### Type Check

Run TypeScript type checking:

```bash
npm run typecheck
```

### Testing

Run tests:

```bash
npm run test
```

Run tests with coverage:

```bash
npm run test:coverage
```

### Clean Build

Remove compiled files:

```bash
npm run clean
```

## Requirements

- Node.js >= 22.0.0
- Docker and Docker Compose
- Access to compose.yml and environment files

## Dependencies

- `@rfmedia/common` - Shared utilities (logging, spinners, prompts)
- `commander` - CLI framework
- `ipaddr.js` - IPv4 and IPv6 CIDR normalization for conflict validation
- `listr2` - Task runner with progress
- `picocolors` - Terminal colors
- `yaml` - YAML parsing

## License

MIT
