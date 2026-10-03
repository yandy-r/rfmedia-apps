# rfapps Audit Command

`rfapps audit` is a read-only security posture command for resolved Docker
Compose configuration. It checks container identity, privileges, host access,
and resource guardrails, then reports advisory findings with stable rule IDs and
remediation guidance.

## Scope

Audit inspects the resolved output from Docker Compose config, including compose
files, selected profiles, environment file interpolation, and supported secrets
tool execution. It does not parse raw YAML directly.

Audit does not start, stop, recreate, remove, or prune containers. It does not
write compose/config files, save plans, record deployment state, inspect running
containers, query registries, emit SARIF, or apply remediations.

`rfapps doctor` aggregates audit-derived security findings under its `security`
category. `rfapps lint` remains the production-readiness command and owns SARIF
output and lint suppressions.

## Usage

```bash
rfapps audit
rfapps audit -s traefik
rfapps audit -g media-stack
rfapps audit --services plex,sonarr --no-sidecars
rfapps audit --json
rfapps audit --fail-on warn
rfapps audit --fail-on none
```

## Targeting

Audit reuses the same targeting and compose override behavior as other rfapps
commands.

| Option                  | Description                         |
| ----------------------- | ----------------------------------- |
| `-s, --service <name>`  | Target one service                  |
| `--services <names>`    | Target comma-separated services     |
| `-g, --group <name>`    | Target a configured service group   |
| `--no-sidecars`         | Disable automatic sidecar expansion |
| `-f, --compose <path>`  | Use a specific compose file         |
| `-e, --env-file <path>` | Use a specific environment file     |
| `-p, --profile <name>`  | Use a Docker Compose profile        |

## Rules

| Rule ID                 | Severity   | Category      | Trigger                                |
| ----------------------- | ---------- | ------------- | -------------------------------------- |
| `privileged-container`  | `critical` | `privileges`  | `privileged: true`                     |
| `docker-socket-mounted` | `critical` | `host-access` | Docker socket in short or long volumes |
| `host-networking`       | `error`    | `host-access` | `network_mode: host`                   |
| `root-user`             | `warn`     | `identity`    | Missing, empty, root, or UID 0 `user`  |
| `capability-added`      | `warn`     | `privileges`  | One or more `cap_add` entries          |
| `cap-drop-missing`      | `info`     | `privileges`  | Missing `cap_drop: ["ALL"]`            |
| `service-networking`    | `info`     | `host-access` | `network_mode: service:*`              |
| `memory-limit-missing`  | `info`     | `resources`   | Missing memory resource limit          |
| `cpu-limit-missing`     | `info`     | `resources`   | Missing CPU resource limit             |

## Output

Human output is written to stderr and groups findings by severity, then service.
Machine output is written to stdout through the shared formatter.

```bash
rfapps audit --json
```

```json
{
  "schemaVersion": "audit.v1",
  "timestamp": "2026-06-10T03:00:00.000Z",
  "scope": {
    "services": ["traefik"],
    "profiles": ["core"],
    "composePath": "compose.yml"
  },
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
      "remediation": "Avoid mounting `/var/run/docker.sock`; use a scoped proxy or a purpose-built integration with limited permissions."
    }
  ]
}
```

Evidence is bounded to field paths, booleans, service names, mount targets, and
other non-secret strings. Audit does not print raw resolved service objects.

## Exit Thresholds

Findings use this severity order:

```text
critical > error > warn > info
```

The default threshold is `--fail-on critical`. Use `--fail-on none` for
always-zero advisory runs, or a stricter threshold for CI.

```bash
rfapps audit --fail-on none
rfapps audit --fail-on warn --json
rfapps audit -s traefik --fail-on critical
```
