# Plan/Apply Workflow

The `rfapps plan` and `rfapps apply` commands provide a Terraform-inspired workflow for previewing and applying Docker service changes safely.

## Overview

The plan/apply workflow allows you to:

- Preview changes before deploying
- Detect configuration drift between running state and compose file
- Check for newer image versions on registries
- Apply changes with validation and safety checks
- Route reviewed image updates through a separate verify-and-recover lifecycle

The persisted plan/apply workflow is distinct from `rfapps reconcile`. Reconciliation observes and
plans in memory, reports without mutation by default, and can apply only that same process's review
when `--auto-apply` is explicit. It never creates a plan file, history entry, generation, or rollback
record.

## Reconciliation Workflow Boundary

Use reconciliation when the existing Compose declaration is authoritative and the goal is to
observe or correct current container state without changing image registry intent:

```bash
# Read-only report; drift is reported without a failing exit when observation succeeds
rfapps reconcile -g media-stack

# Complete deterministic reconcile.v1 document
rfapps reconcile --services plex,tautulli --json

# Preview auto-apply intent; global dry-run still prevents mutation
rfapps reconcile -s plex --auto-apply --dry-run

# Confirm, then run the locked same-process lifecycle
rfapps reconcile -s plex --auto-apply

# Non-interactive machine-format mutation requires both flags
rfapps reconcile -s plex --auto-apply --yes --output yaml
```

`--auto-apply` is the only reconciliation mutation gate. `--yes` only skips confirmation, and
`--dry-run` always wins. Before acting, the coordinator acquires the project/Docker lifecycle lock
shared with managed update and revalidates the reviewed Compose, environment, Docker, scope,
container, drift, policy, and action evidence. It then rechecks each service, runs an exact targeted
Compose action, requires readiness plus fresh zero drift, and releases the lock in `finally`.

Reconciliation actions use `up -d --pull never --no-deps SERVICE`; only `recreate` adds
`--force-recreate`. The command never removes orphans, pulls or builds images, renews volumes,
starts implicit dependencies, imports runtime changes, or widens the reviewed scope. It also has no
automatic data or image rollback: rerunning reconciliation observes the remaining drift.

| Exit code | Reconciliation meaning                                         |
| --------- | -------------------------------------------------------------- |
| `0`       | Trustworthy report, no action needed, or fully converged scope |
| `1`       | Observation or reconciliation operation failed                 |
| `2`       | Invalid/unsafe usage or cancellation                           |
| `3`       | Partial, blocked, or residual-drift result                     |

Version 1's injected eligibility policy allows explicitly authorized actions. Maintenance-window
schedules and configuration remain future work in issue #169; no window is enforced by this
release.

Choose the workflow by intent:

| Workflow         | Review lifetime           | Persistence                         | Registry and recovery behavior                             |
| ---------------- | ------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `plan` / `apply` | May cross processes       | Saved deployment plan               | May pull during apply; no reconcile-specific recovery      |
| `reconcile`      | Same process only         | None                                | Never pulls; no rollback; re-observe on the next run       |
| `update`         | New or saved managed plan | Plan, final report, and generations | Pulls reviewed digest; can restore exact prior local image |

## Plan Command

Generate a deployment plan showing what will change:

```bash
rfapps plan [options]
```

### Key Features

**Change Detection:**

- Compares running container state with compose file configuration
- Detects changes to images, environment variables, ports, volumes, and networks
- Shows detailed diffs for each service

**Image Update Detection:**

- Use `--check-updates` to compare local image digests with registry digests
- Detects newer versions without pulling images
- Works with Docker Hub, GHCR, and private registries
- Skips built images (services using `build` context)

**Output Formats:**

- Human-readable diff output (default)
- JSON output for scripting (`--json`)
- Verbose mode for complete configuration (`--verbose`)

### Options

| Option               | Short | Description                                              |
| -------------------- | ----- | -------------------------------------------------------- |
| `--service <name>`   | `-s`  | Target a specific service                                |
| `--services <names>` |       | Target multiple services (comma-separated)               |
| `--group <name>`     | `-g`  | Target a service group                                   |
| `--no-sidecars`      |       | Disable automatic sidecar linking                        |
| `--apply`            |       | Immediately apply the plan after generation              |
| `--out <path>`       | `-o`  | Custom plan output path                                  |
| `--show-unchanged`   |       | Show unchanged services in output                        |
| `--check-updates`    |       | Check registry for newer image versions                  |
| `--explain`          |       | Annotate changes with likely cause and dependency impact |
| `--compose <path>`   | `-f`  | Path to Docker Compose file                              |
| `--env-file <path>`  | `-e`  | Path to environment file                                 |
| `--profile <name>`   | `-p`  | Docker Compose profile to use                            |

### Change Types

The plan output uses symbols to indicate change types:

- `+` (green) - Service will be created
- `~` (cyan) - Service will be recreated (image changed)
- `!` (yellow) - Service will be updated (config changed)
- `-` (red) - Service will be deleted
- `=` (gray) - Service unchanged
- `^` (yellow) - Image update available (when using `--check-updates`)

### Plan Output Example

```bash
$ rfapps plan -s traefik --check-updates --verbose

Deployment Plan
Plan ID: abc123...
Compose: /path/to/compose.yml

= unchanged traefik
  image: traefik:v3 (update available)
  environment:
    CF_DNS_API_TOKEN: ********
    DOMAIN: home.example.dev
    DOMAIN2: home.example.media
    TZ: America/New_York
  ports:
    (none)
  volumes:
    = /var/run/docker.sock:/var/run/docker.sock:ro
    = /home/user/.config/docker/traefik:/etc/traefik
  networks:
    (none)

Summary:
  = 1 unchanged
  ^ 1 update available
```

### Image Update Detection

When using `--check-updates`, the plan command:

1. Queries the registry for each service's image using `docker manifest inspect`
2. Compares the remote digest with the local image digest
3. Reports if a newer version is available

**How It Works:**

- Uses Docker's manifest API to get image digests without pulling
- Compares SHA256 hashes to detect differences
- Runs checks in parallel for performance
- Handles authentication via `~/.docker/config.json`

**Limitations:**

- Requires `DOCKER_CLI_EXPERIMENTAL=enabled` (automatically set)
- Only works for images pulled from registries (not local builds)
- May fail for private registries without proper authentication

`rfapps plan --check-updates` is read-only and advisory. It can report image freshness, but it does
not create managed update intent, pin the reviewed repository digest for apply, verify the updated
target, or recover a failed update. Use `rfapps update` for that lifecycle.

### Change Origin and Impact

`rfapps plan --explain` annotates each changed service with why it changed and what declares a
dependency on it. It is opt-in and read-only: it issues no additional Docker commands, mutates
nothing, and leaves the plan payload byte-identical when the flag is absent.

Each annotation is a typed reason with a stable code, a kind (`trigger`, `provenance`, or
`advisory`), and a confidence of `confirmed` or `inferred`. Triggers explain the change type — which
of image, environment, ports, volumes, or networks moved, and which one forced the verdict.
Provenance explains where the change originated by comparing the resolved configuration fingerprint
against the newest scope-compatible saved plan; both "the configuration moved" cases are `inferred`
and name their alternatives, because a secrets-tool switch or a Docker Compose CLI upgrade produces
the same signal as an edit. The single advisory reason reports that the locally cached image for an
unchanged reference is behind the registry, and is emitted only under `--check-updates`.

Impact is derived from Compose declarations alone. It reports the effect on the service's own
container, whether the service maps to the `core` profile, and how many services transitively
declare `depends_on` it (with how many of those are currently running). Compose `depends_on` governs
start ordering, not runtime coupling, so the count is reported as a declaration and the line is
omitted entirely when a service has no dependents.

`--explain` selects the data; the global `-v, --verbose` selects the depth. Annotations are attached
at the plan level as one additive optional key, `plan.intelligence`, carried by `--output json` and
`--output yaml` and stripped for `table` and `csv`.

```bash
# Concise cause and impact annotations
rfapps plan -s plex --explain

# Full reason blocks with evidence
rfapps plan -s plex --explain --verbose

# Include registry drift for services whose declaration did not change
rfapps plan --explain --check-updates
```

See [rfapps Plan Intelligence](rfapps-plan-intelligence.md) for the complete reason-code table, the
degradation ladder, and the documented limitations.

### Examples

```bash
# Basic plan for a single service
rfapps plan -s traefik

# Check for image updates
rfapps plan -s traefik --check-updates

# Plan with verbose output showing all configuration
rfapps plan -s plex --verbose

# Plan for multiple services
rfapps plan --services sonarr,radarr,bazarr

# Plan for a service group
rfapps plan -g media-stack

# Check for updates across all services
rfapps plan --check-updates --verbose

# Generate plan with secrets management
rfapps plan -s traefik --use-dotenvx .env.local

# Save plan to custom location
rfapps plan -s plex -o /tmp/plex-plan.json
```

## Managed Image Update Workflow

`rfapps update` is preview-first and separate from ordinary configuration plans. A bare invocation
checks registry and daemon-local image identities, renders sanitized status, and writes an
`update-plan.v1` managed plan without pulling or recreating containers.

```bash
# Preview one service
rfapps update -s plex

# Preview a group to a known review path
rfapps update -g media-stack --out .rfapps/plans/media-update.json

# Generate, confirm once, and apply
rfapps update -s plex --apply

# Apply an already reviewed managed plan
rfapps update --from-plan .rfapps/plans/media-update.json --apply --yes
```

The command supports `--service`, comma-separated `--services`, and `--group`. Sidecars expand
according to configuration unless `--no-sidecars` is selected during plan generation. A saved plan
owns its reviewed scope: `--from-plan` cannot be combined with service/group, Compose, profile, or
sidecar overrides. Global `--dry-run` keeps `--apply` preview-only, and machine-format apply requires
`--apply --yes`.

Preview plans default to `.rfapps/plans/update-{timestamp}.json`. During preview, `--out` selects the
managed-plan path. During apply, it selects the final secret-free `update.v1` report path; otherwise
reports are written under `.rfapps/reports/`.

Sanitized human preview output resembles:

```text
Managed image update plan
Plan ID: update-plan-example
  plex: update-available -> registry.example.invalid/media/plex@sha256:2222...
Plan: /srv/rfapps/.rfapps/plans/media-update.json
```

### Revalidation, Sequencing, and Recovery

Immediately before mutation, managed apply locks the project/Docker context and revalidates the
Compose hash, selected scope, Docker context, configured image, current local image identity,
platform, proposed repository digest, and exact recovery identity. Any drift blocks all mutation
and requires a new preview. There is no force option or bypass for managed identity drift.

Actionable services update sequentially. Each target must use the reviewed image and pass target
verification. If an updated target fails verification, rfapps restores and verifies the exact
captured daemon-local image by default. A verified restore allows later services to continue but
keeps the overall result failed; a restore failure stops remaining work. Use
`--no-restore-on-failure` only when accepting reduced safety explicitly.

Recovery is image-only under the current Compose configuration. It does not restore Compose
configuration, volumes, application data, databases, or migrations.

| Exit code | Managed update meaning                                                              |
| --------- | ----------------------------------------------------------------------------------- |
| `0`       | Preview/no-update result is complete, or every applied update verified successfully |
| `1`       | Detection, drift, update, verification, interruption, or recovery failure           |
| `2`       | Invalid arguments, unsafe path, or invalid managed plan                             |

## Apply Command

Apply a saved deployment plan:

```bash
rfapps apply <plan-file> [options]
```

`rfapps apply` accepts ordinary deployment plans only. It rejects managed plans identified by
`intent: "managed-update"`; `--force` cannot cross this boundary. Use the correct managed route:

```bash
rfapps update --from-plan .rfapps/plans/media-update.json --apply --yes
```

### Plan Validation

Before applying, the command validates:

- Plan file exists and is valid JSON
- Compose file hash matches (prevents applying outdated plans)
- Plan age (warns if older than 24 hours)

### Apply Process

1. **Validation** - Check plan validity and compose file hash
2. **Pull Images** - Pull images for services with image changes
3. **Deploy Services** - Start/update services according to plan
4. **Verification** - Verify services are running after deployment

### Options

| Option        | Description                                       |
| ------------- | ------------------------------------------------- |
| `<plan-file>` | Path to plan file (required)                      |
| `--force`     | Apply even if plan is stale (compose.yml changed) |

### Examples

```bash
# Apply a saved plan
rfapps apply .rfapps/plans/plan-2026-01-20-21-14-29-426.json

# Apply with force (ignore stale plan warning)
rfapps apply plan.json --force --yes

# Apply with JSON output for scripting
rfapps apply plan.json --json
```

## Workflow Examples

### Drift Checks Around Updates

Use `rfapps drift` as a read-only signal before and after plan/apply. Drift does
not run as a daemon and does not reconcile automatically.

```bash
# Pre-update: catch runtime or config drift first
rfapps drift detect --report-only --json | jq '.summary'

# Preview and apply intended changes
rfapps plan --check-updates
rfapps apply .rfapps/plans/plan-2026-01-20-21-14-29-426.json --yes

# Post-update: verify the running state is aligned
rfapps drift detect --report-only --json | jq '.services[] | select(.hasDrift)'
```

If drift should be corrected from Compose, use the report-first reconciliation path:

```bash
rfapps reconcile -s plex
rfapps reconcile -s plex --auto-apply --yes
```

The legacy `rfapps drift reconcile` spelling delegates to the same auto-apply coordinator.

Managed update performs its own fail-closed identity revalidation after approval. A separate drift
check is useful operator context, but it cannot replace or bypass the managed Compose/context/image
checks.

### Basic Preview and Apply

```bash
# Step 1: Generate plan
rfapps plan -s traefik
# Output: Plan saved to .rfapps/plans/plan-2026-01-20-21-14-29-426.json

# Step 2: Review the plan output
# (shows what will change)

# Step 3: Apply the plan
rfapps apply .rfapps/plans/plan-2026-01-20-21-14-29-426.json --yes
```

### Check for Updates

```bash
# Advisory check: report which services may have newer images
rfapps plan --check-updates

# Actionable preview: save reviewed identities without mutation
rfapps update -g media-stack --out .rfapps/plans/media-update.json

# Apply the reviewed identities through verification and recovery
rfapps update --from-plan .rfapps/plans/media-update.json --apply --yes
```

### Combined Plan and Apply

```bash
# Generate and apply in one command
rfapps plan -s plex --apply --yes
```

### Plan with Secrets

```bash
# Generate plan with secrets injection
rfapps plan -s traefik --use-dotenvx .env.local

# Apply plan (secrets are already in compose config)
rfapps apply .rfapps/plans/plan-*.json --yes
```

## Plan File Format

Ordinary deployment plans are saved as JSON files with the following structure:

```json
{
  "id": "unique-plan-id",
  "createdAt": "2026-01-20T21:14:29.426Z",
  "composeHash": "sha256-hash-of-compose-file",
  "composePath": "/path/to/compose.yml",
  "targetServices": ["plex", ""],
  "profiles": ["core"],
  "services": [
    {
      "service": "traefik",
      "changeType": "unchanged",
      "image": {
        "current": "traefik:v3",
        "desired": "traefik:v3",
        "changed": false,
        "updateAvailable": true,
        "localDigest": "sha256:abc123...",
        "remoteDigest": "sha256:def456..."
      },
      "environment": [...],
      "ports": {...},
      "volumes": {...},
      "networks": {...}
    }
  ],
  "summary": {
    "toCreate": 0,
    "toUpdate": 0,
    "toRecreate": 0,
    "toDelete": 0,
    "unchanged": 1,
    "updatesAvailable": 1,
    "total": 1
  }
}
```

Managed plans are a separate allowlisted schema with `schemaVersion: "update-plan.v1"` and
`intent: "managed-update"`. They store reviewed service/image identities and policy, not resolved
environment values. Do not edit or route them through ordinary `rfapps apply`; load them with
`rfapps update --from-plan <path>`.

There is no saved reconciliation-plan schema. A `reconcile.v1` document is a terminal report, not
an input to `rfapps apply` or a replayable action log.

## Secret Masking

Environment variables containing secrets are automatically masked in plan output. Secret detection uses keyword matching:

- `token`, `key`, `secret`, `password`, `passwd`, `pwd`
- `api_key`, `apikey`, `auth`, `credential`, `private`

Example output:

```
+ environment.CF_DNS_API_TOKEN: ********
~ environment.PASSWORD (secret value changed)
+ environment.TZ: "America/New_York"  ← Non-secrets show values
```

## Best Practices

1. **Always review plans before applying** - Use `plan` to preview changes
2. **Check for updates regularly** - Use `--check-updates` to find newer images
3. **Use verbose mode for debugging** - `--verbose` shows complete configuration
4. **Validate plans before applying** - The apply command checks plan validity
5. **Don't apply stale plans** - Plans are tied to specific compose file versions
6. **Use managed update for image mutation** - It pins reviewed identity, verifies targets, and
   provides exact-image recovery
7. **Re-plan after managed drift** - Managed identity drift has no force bypass
8. **Use reconcile for declared-state convergence** - Report first, then add `--auto-apply` only
   when current containers should be corrected toward existing Compose intent

## Troubleshooting

### Plan shows services as "create" when they're running

This usually indicates a service/container name mismatch. The plan command uses service names from the compose file, but Docker may assign different container names after conflicts. Rebuild the service to fix:

```bash
rfapps rebuild -s <service> --yes
```

### Update check fails for private registry

Ensure Docker is authenticated to the registry:

```bash
docker login <registry-url>
```

The plan command uses Docker's authentication from `~/.docker/config.json`.

### Plan shows false changes

The plan compares configuration, not just running state. If volumes, ports, or networks appear in different orders, they're still considered equivalent (order-independent comparison).

### Built images show as "recreate"

Services using `build` context instead of `image` tags are handled specially. The plan uses the current running image as both current and desired state.

### Managed plan is rejected by apply

This is intentional. Ordinary apply cannot execute managed update intent, even with `--force`:

```bash
rfapps update --from-plan .rfapps/plans/media-update.json --apply --yes
```

### Managed update reports identity drift

Compose, Docker context, selected scope, current image, platform, or proposed digest changed after
review. Nothing is mutated. Generate and review a new plan instead of trying to force the stale one:

```bash
rfapps update -g media-stack --out .rfapps/plans/media-update-new.json
```

## Related Documentation

- [Quick Reference](quick-reference.md) - One-page command reference card
- [rfapps Plan Intelligence](rfapps-plan-intelligence.md) - `--explain` cause annotations, dependency impact, and limitations
- [rfapps Update Command](../../packages/rfapps-cli/README.md#update) - Managed update options and safety contract
- [rfapps Reconcile Command](rfapps-reconcile-command.md) - Same-process report and convergence contract
- [rfapps CLI Reference](../reference/rfapps-cli-reference.md) - Complete command documentation
- [Dry-Run Mode](dry-run-mode.md) - Preview actions without executing
- [JSON Output Mode](json-output.md) - Machine-readable output for scripting
- [Secrets Management](secrets-management.md) - Environment variable encryption
- [Sidecar Linking](sidecar-linking.md) - Automatic sidecar management
