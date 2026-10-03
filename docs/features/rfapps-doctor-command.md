# rfapps Doctor Command

`rfapps doctor` is a read-only diagnostic command for operators and automation. It
aggregates configuration hygiene, security posture, runtime status, dependency
readiness, optional image freshness, and rfapps state history into one stable
result.

## Read-Only Guarantees

By default, doctor only inspects existing state:

- Resolved Docker Compose configuration
- Docker container status and dependency readiness signals
- Existing rfapps SQLite state history
- Registry image metadata only when `--check-updates` is provided

Doctor does not start, stop, recreate, remove, or prune containers. It does not
write compose/config files, save deployment plans, or record deployment state.
When the state database does not already exist, the state check is skipped rather
than creating a new database file.

## Usage

```bash
rfapps doctor
rfapps doctor -g media-stack
rfapps doctor -s plex --no-sidecars
rfapps doctor --check-updates
rfapps doctor --json
rfapps doctor --fail-on warn
```

## Checks

| Check           | Default | Category   | Notes                                                   |
| --------------- | ------- | ---------- | ------------------------------------------------------- |
| Config lint     | Yes     | `config`   | Maps existing production-readiness lint findings        |
| Security audit  | Yes     | `security` | Consumes shared `rfapps audit` security findings        |
| Runtime status  | Yes     | `runtime`  | Reports unhealthy, dead, restarting, or stopped targets |
| Readiness       | Yes     | `runtime`  | Uses snapshot dependency readiness checks               |
| State history   | Yes     | `state`    | Reads existing deployment history only                  |
| Image freshness | No      | `updates`  | Requires `--check-updates` and never saves a plan       |

## Targeting

Doctor reuses the same targeting behavior as other rfapps commands:

| Option                  | Description                           |
| ----------------------- | ------------------------------------- |
| `-s, --service <name>`  | Target one service                    |
| `--services <names>`    | Target comma-separated services       |
| `-g, --group <name>`    | Target a configured service group     |
| `--no-sidecars`         | Disable automatic sidecar expansion   |
| `-f, --compose <path>`  | Use a specific compose file           |
| `-e, --env-file <path>` | Use a specific environment file       |
| `-p, --profile <name>`  | Use a specific Docker Compose profile |

## Severity and Exit Codes

Findings use this severity order:

```text
critical > error > warn > info
```

The default threshold is `--fail-on critical`, so ordinary warnings and errors
remain advisory unless a critical issue is found. Use a stricter threshold for CI
or `--fail-on none` for always-zero advisory diagnostics.

```bash
rfapps doctor --fail-on none
rfapps doctor --fail-on warn
rfapps doctor --fail-on critical
```

## JSON Schema

JSON output is versioned with `schemaVersion: "doctor.v1"` and is emitted to
stdout through the shared formatter.

```bash
rfapps doctor --json
```

```json
{
  "schemaVersion": "doctor.v1",
  "timestamp": "2026-06-10T02:00:00.000Z",
  "scope": {
    "services": ["plex"],
    "profiles": ["media"],
    "composePath": "compose.yml",
    "checkUpdates": false
  },
  "summary": {
    "critical": 0,
    "error": 1,
    "warn": 0,
    "info": 0,
    "total": 1
  },
  "checks": [
    {
      "id": "runtime-status",
      "category": "runtime",
      "status": "run"
    }
  ],
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

## Automation Examples

```bash
# Fail only on critical findings
rfapps doctor --json | jq '.summary'

# CI gate for warnings and above
rfapps doctor --fail-on warn --json

# List suggested follow-up commands
rfapps doctor --json | jq -r '.findings[].suggestedCommand // empty'

# Check registry freshness explicitly
rfapps doctor --check-updates --json | jq '.findings[] | select(.category == "updates")'
```

## Suggested Commands

Doctor findings point to existing read-only diagnostic flows first:

- `rfapps health -s <service> --no-wait-for-ready`
- `rfapps status -s <service> --health`
- `rfapps lint -s <service>`
- `rfapps audit -s <service>`
- `rfapps plan -s <service> --check-updates`
- `rfapps history -s <service> --limit 5`

Doctor does not apply remediations automatically.
