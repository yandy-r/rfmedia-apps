# rfapps Drift Command

`rfapps drift` detects differences between resolved Docker Compose declarations and live Docker
state. It is intended for day-2 operations: scheduled checks, pre-update review, post-update
verification, and explicit reconcile/import workflows.

## Read-Only Guarantees

The read commands do not mutate containers or files:

- `rfapps drift detect`
- `rfapps drift show`

They inspect resolved compose config, container inspect data, and runtime status/health. They do not
start, stop, recreate, remove, or prune containers. They do not edit `compose.yml`, write backups,
save plans, or record deployment state.

Mutation remains explicit and separated by direction:

- `rfapps reconcile --auto-apply` applies resolved Compose intent to eligible services
- `rfapps drift reconcile` is a legacy alias for that safe auto-apply workflow
- `rfapps drift import` updates compose from runtime config

## Usage

```bash
rfapps drift detect
rfapps drift detect -g media-stack
rfapps drift detect --json
rfapps drift detect --report-only --json
rfapps drift show -s plex
rfapps reconcile -s plex
rfapps reconcile -s plex --auto-apply --yes
rfapps drift reconcile -s plex --yes
rfapps drift import -s plex --backup --yes
```

## Reconciliation

Use top-level `rfapps reconcile` for a deterministic desired-versus-actual report. Bare execution
is read-only and exits zero when it produces a trustworthy report, even when drift is present:

```bash
rfapps reconcile -g media-stack
rfapps reconcile --services plex,tautulli --json
```

Only `--auto-apply` authorizes target mutation. `--yes` skips confirmation but does not authorize
mutation or bypass stale evidence. Global `--dry-run` always prevents mutation. Machine-format
auto-apply requires `--auto-apply --yes` when actionable work exists.

```bash
rfapps reconcile -s plex --auto-apply
rfapps reconcile -s plex --auto-apply --yes --json
rfapps reconcile -s plex --auto-apply --dry-run
```

The `reconcile.v1` result assigns one `none`, `create`, `start`, `recreate`, or `blocked` action to
every selected service. Auto-apply locks and revalidates the reviewed Compose, project, profile,
service, environment-source, Docker-authority, configuration, container, policy, and drift
evidence. Eligible actions target exactly one service with `--pull never --no-deps`; they never
remove orphans, pull, build, renew volumes, start implicit dependencies, or widen scope. Readiness
and fresh zero drift are required before an action is reported as converged.

The legacy command remains available:

```bash
rfapps drift reconcile -s plex --yes
```

It delegates to the same coordinator with auto-apply intent. It is not the earlier broad
force-recreate implementation. New automation should use `rfapps reconcile --auto-apply`.

Reconciliation is same-process and does not save a reconcile plan, history record, generation, or
rollback artifact. It does not pull registry updates, run a background daemon, or configure a
maintenance schedule. Version 1 permits explicitly authorized actions through an allow-all policy
seam; issue #169 owns future maintenance-window policy. See
[rfapps Reconcile Command](rfapps-reconcile-command.md) for options, result semantics, and exits.

## Drift Categories

| Category         | Meaning                                         |
| ---------------- | ----------------------------------------------- |
| `image`          | Container image differs from compose            |
| `environment`    | Environment variables differ                    |
| `ports`          | Published port mappings differ                  |
| `volumes`        | Volume mounts differ                            |
| `networks`       | Docker networks differ                          |
| `runtime-status` | Container state is not running or health is bad |

Runtime-status drift is reported when selected services are missing, exited, paused, restarting,
dead, created, unhealthy, or still starting. Running services with `healthy` or no healthcheck are
treated as runtime-aligned.

## Secrets

Secret-like environment names such as `PASSWORD`, `TOKEN`, `API_KEY`, `SECRET`, and `PRIVATE_KEY`
are masked before drift results reach human or machine output. JSON, YAML, and CSV output contain
`********` instead of raw secret values.

## JSON Output

Machine output is versioned with `schemaVersion: "1.0.0"` and emitted to stdout. Human text and logs
stay on stderr.

```bash
rfapps drift detect --json
```

```json
{
  "schemaVersion": "1.0.0",
  "timestamp": "2026-06-10T03:30:00.000Z",
  "composePath": "compose.yml",
  "services": [
    {
      "service": "plex",
      "hasDrift": true,
      "direction": "compose_ahead",
      "categories": ["runtime-status"],
      "image": { "changed": false },
      "environment": [],
      "ports": { "changed": false },
      "volumes": { "changed": false },
      "networks": { "changed": false },
      "runtimeStatus": {
        "current": { "state": "exited", "health": "none" },
        "desired": { "state": "running", "health": "none" },
        "changed": true
      }
    }
  ],
  "summary": {
    "total": 1,
    "drifted": 1,
    "unchanged": 0,
    "directions": {
      "composeAhead": 1,
      "containerAhead": 0,
      "diverged": 0
    }
  }
}
```

## Exit Behavior

Completed detect/show commands exit non-zero when drift is found. Use `--report-only` for
dashboards, cron jobs, or MCP clients that should collect drift without failing the process.

```bash
rfapps drift detect --json
rfapps drift detect --report-only --json
```

Command execution failures still use the normal formatted error path and set a non-zero exit code.

## Scheduler Examples

Cron:

```cron
15 * * * * cd /srv/rfmedia-apps && rfapps drift detect --json > /var/log/rfapps-drift.json
```

Systemd timer service:

```ini
[Service]
Type=oneshot
WorkingDirectory=/srv/rfmedia-apps
ExecStart=/usr/local/bin/rfapps drift detect --json
```

Use `--report-only` when the scheduler treats any non-zero exit as a failed job but drift should
remain advisory.

## Update Workflow

Use drift before and after plan/apply:

```bash
rfapps drift detect --json | jq '.summary'
rfapps plan --check-updates
rfapps apply .rfapps/plans/plan.json --yes
rfapps drift detect --report-only --json | jq '.services[] | select(.hasDrift)'
```

Drift is a signal. It does not schedule itself and does not automatically reconcile containers.
Use `rfapps reconcile` for a report or add `--auto-apply` for explicit Compose-to-runtime
convergence.

## MCP

Read-only MCP tools:

- `rfapps.drift.detect`
- `rfapps.drift.show`

Mutation MCP tools:

- `rfapps.drift.reconcile`
- `rfapps.drift.import`

The read tools return the same versioned drift result shape as CLI JSON output and accept
`reportOnly`.

`rfapps.drift.reconcile` delegates to the same safe reconciliation coordinator and returns the
`reconcile.v1` result. Runtime import remains a separate explicit operation.
