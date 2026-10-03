# Output Formats

This document describes the alternative output formats available in both the rfapps CLI and rfmedia
CLI. The `--output` option provides machine-readable and human-readable output formats for
scripting, automation, and integration with other tools.

## Overview

Both CLIs support a `--output <format>` global option with five format choices:

| Format  | Type             | Stdout Data | Logs/Progress |
| ------- | ---------------- | ----------- | ------------- |
| `text`  | Human-readable   | No          | Shown         |
| `table` | Human-readable   | No          | Shown         |
| `json`  | Machine-readable | Yes         | Suppressed    |
| `yaml`  | Machine-readable | Yes         | Suppressed    |
| `csv`   | Machine-readable | Yes         | Suppressed    |

Machine-readable formats (`json`, `yaml`, `csv`) suppress all human-readable output -- logs,
progress spinners, and colored text -- to keep stdout clean for structured data. Human-readable
formats (`text`, `table`) show normal output with colors and progress indicators.

The `--json` flag is preserved for backward compatibility and is internally equivalent to
`--output json`.

## Enabling Output Formats

### Using --output

Add `--output <format>` to any command in either CLI:

```bash
# rfapps examples
rfapps status --output json
rfapps deploy -s traefik --output yaml --yes
rfapps status --output csv
rfapps audit --output json
rfapps drift detect --output json --report-only

# rfmedia examples
rfmedia stats --output json
rfmedia history --output yaml
rfmedia stats --output csv
rfmedia reconcile scan /mnt/media/music --output json
```

### Using --json (backward compatible)

The `--json` flag continues to work as before:

```bash
rfapps status --json
rfmedia stats --json
```

### Flag Precedence

When both `--json` and `--output` are specified, `--output` takes precedence. A warning is logged
when the two flags conflict:

```bash
# --output takes precedence; warns if format differs from json
rfapps status --json --output yaml
# WARNING: Both --json and --output were specified; --output takes precedence.
```

When `--json` is used without `--output`, it behaves identically to `--output json`.

### No Short Flag

The `--output` option is long-only. There is no `-o` short flag to avoid collision with existing
local options:

- rfapps `plan -o, --out <path>` (plan output file path)
- rfmedia `playlist create -o, --output <path>` (M3U output file path)

## Format Details

### JSON (`--output json`)

Pretty-printed JSON with 2-space indentation. This is the same output as the legacy `--json` flag.

**rfapps status example:**

```bash
rfapps status --output json
```

```json
{
  "timestamp": "2026-01-18T10:30:00.000Z",
  "services": [
    {
      "name": "traefik",
      "containerId": "abc123",
      "state": "running",
      "health": "healthy",
      "status": "Up 5 days",
      "ports": ["80:80", "443:443"],
      "image": "traefik",
      "tag": "v3.0"
    },
    {
      "name": "plex",
      "containerId": "def456",
      "state": "running",
      "health": "healthy",
      "status": "Up 3 days",
      "ports": ["32400:32400"],
      "image": "plexinc/pms-docker",
      "tag": "latest"
    }
  ],
  "total": 35,
  "running": 33,
  "healthy": 32
}
```

**rfapps doctor example:**

```bash
rfapps doctor --output json
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

**rfapps audit example:**

```bash
rfapps audit --output json
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
      "remediation": "Avoid mounting `/var/run/docker.sock`; use a scoped proxy or limited integration."
    }
  ]
}
```

**rfapps drift example:**

```bash
rfapps drift detect --output json --report-only
```

```json
{
  "schemaVersion": "1.0.0",
  "timestamp": "2026-06-10T03:30:00.000Z",
  "composePath": "compose.yml",
  "services": [],
  "summary": {
    "total": 0,
    "drifted": 0,
    "unchanged": 0,
    "directions": {
      "composeAhead": 0,
      "containerAhead": 0,
      "diverged": 0
    }
  }
}
```

**rfmedia stats example:**

```bash
rfmedia stats --output json
```

```json
{
  "command": "stats",
  "result": {
    "operations": [
      {
        "command": "copy-album",
        "total": 10,
        "completed": 8,
        "failed": 1,
        "partial": 1,
        "successRate": 80.0
      }
    ],
    "totalFiles": 1500,
    "totalSize": 15000000000,
    "storageByRating": [{ "range": "4-5 stars", "fileCount": 500, "totalSize": 5000000000 }],
    "successRateByMode": { "album": 85.0, "filter": 75.0 }
  }
}
```

### YAML (`--output yaml`)

YAML 1.2 format using the `yaml` package (v2). Produces clean, readable output suitable for
configuration pipelines and tools that consume YAML natively.

**rfapps status example:**

```bash
rfapps status --output yaml
```

```yaml
timestamp: "2026-01-18T10:30:00.000Z"
services:
  - name: traefik
    containerId: abc123
    state: running
    health: healthy
    status: Up 5 days
    ports:
      - "80:80"
      - "443:443"
    image: traefik
    tag: v3.0
  - name: plex
    containerId: def456
    state: running
    health: healthy
    status: Up 3 days
    ports:
      - "32400:32400"
    image: plexinc/pms-docker
    tag: latest
total: 35
running: 33
healthy: 32
```

**rfmedia stats example:**

```bash
rfmedia stats --output yaml
```

```yaml
command: stats
result:
  operations:
    - command: copy-album
      total: 10
      completed: 8
      failed: 1
      partial: 1
      successRate: 80
  totalFiles: 1500
  totalSize: 15000000000
  storageByRating:
    - range: 4-5 stars
      fileCount: 500
      totalSize: 5000000000
  successRateByMode:
    album: 85
    filter: 75
```

### CSV (`--output csv`)

RFC 4180 compliant CSV output. Best suited for flat or tabular data such as service listings,
operation history, and statistics.

**Supported input shapes:**

| Input Shape      | Behavior                                                   |
| ---------------- | ---------------------------------------------------------- |
| Array of objects | Header row from keys, one data row per object              |
| Flat object      | Header row from keys, single data row                      |
| Nested object    | Dot-notation flattening up to 2 levels (e.g., `image.tag`) |

**Nesting limit:** CSV supports up to 2 levels of nesting. Data with deeper nesting (3+ levels)
produces an error suggesting `--output json` or `--output yaml` instead.

**Array values:** Arrays within objects are serialized as JSON strings in their CSV cells.

`rfapps deploy --validate-first` is an exception: its versioned validation evidence is nested and
is supported only by JSON and YAML machine output. Combining `--output csv` with
`--validate-first` is a usage error (exit `2`) and produces no CSV document.

`rfapps backup` and `rfapps backup verify` are also JSON/YAML-only in machine mode. Their nested
source, consumer, recovery, restore-hint, and integrity evidence cannot be flattened without loss.
Combining either operation with `--output csv` is a usage error (exit `2`) and produces no CSV
document.

`rfapps tag list` and `rfapps tag show` are the same exception. Both results are hierarchical — a
tag carries a service array, and a service carries declared and effective tag arrays — so CSV would
either truncate or JSON-encode the payload that is the entire point of the command. Combining either
with `--output csv` is a usage error (exit `2`) that produces no CSV document:
`Invalid value 'csv' for --output: Tag output is hierarchical; use json, yaml, or table`.
`rfapps tag suggest` is unaffected because its fragment is YAML text, not a table.

`rfapps deploy --staged` is a softer exception: the `staged` summary is dropped from `csv` and
`table` deploy results rather than rejected, so those formats keep a flat, stable column set. Use
`--output json` or `--output yaml` when the rollout summary matters.

`--output table` and `--output csv` are the same softer exception for security payloads: they strip
the nested `scan` report from `plan` and `deploy` results and the nested `proposals`, `refusals`, and
`override` detail from `harden`. Use `json` or `yaml` when automating against those payloads.

**rfapps status example:**

```bash
rfapps status --output csv
```

```csv
name,containerId,state,health,status,ports,image,tag
traefik,abc123,running,healthy,Up 5 days,"[""80:80"",""443:443""]",traefik,v3.0
plex,def456,running,healthy,Up 3 days,"[""32400:32400""]",plexinc/pms-docker,latest
```

**rfmedia history example:**

```bash
rfmedia history --output csv
```

```csv
id,createdAt,command,mode,status,totalSources,completedCount,failedCount
1,2026-01-15T10:30:00.000Z,copy-album,album,completed,50,50,0
2,2026-01-16T14:00:00.000Z,copy-filter,filter,partial,20,18,2
```

### rfmedia Reconciliation Results

`rfmedia reconcile` uses the shared format selection but owns a versioned result contract. JSON
and YAML preserve its nested findings, blockers, target outcomes, and post-apply verification. The
following abbreviated examples show the stable envelope; the full result also includes provenance,
counts, findings, residuals, blockers, failure codes, outcomes, and `postApply`.

```bash
rfmedia reconcile scan /mnt/media/music --library Music --output json
```

```json
{
  "command": "reconcile",
  "result": {
    "schema": "rfmedia.reconcile.v1",
    "status": "scanned",
    "success": true,
    "exitCode": 0,
    "mode": "scan"
  }
}
```

```bash
rfmedia reconcile apply /mnt/media/music --server-wins --output yaml
```

```yaml
command: reconcile
result:
  schema: rfmedia.reconcile.v1
  status: preview
  success: true
  exitCode: 0
  mode: apply
  strategy: server-wins
  executed: false
  executable: true
```

Reconciliation CSV does not use the generic two-level flattener for its nested result. It is a
fixed row union: `summary` is always the first row, followed by zero or more `finding` and
`outcome` rows. Nested values are JSON-encoded in named fixed columns. Selected columns are shown
here for readability:

```csv
command,rowKind,schema,status,success,exitCode,finding.code,outcome.kind
reconcile,summary,rfmedia.reconcile.v1,scanned,true,0,,
reconcile,finding,rfmedia.reconcile.v1,scanned,true,0,conflicting-value,
```

An empty successful scan still emits the complete header and one `summary` row. Ordinary drift and
a successfully computed preview exit `0`; validation or acquisition failure and declined,
blocked, stale, partial, failed, or incompletely verified execution are nonzero. Cancellation exits
`130` for SIGINT and `143` for SIGTERM. Inspect the structured status and counts rather than
treating a scan's exit code as a no-drift test. See the
[metadata reconciliation guide](../../packages/rfmedia-cli/docs/features/metadata-reconciliation.md)
for the complete schema and execution contract.

### Table (`--output table`)

Structured table output rendered by each CLI's table formatting layer. In rfapps, tables use manual
string padding. In rfmedia, tables use the `console-table-printer` library.

Table format is human-readable. Logs and progress indicators are shown. Table output goes to stderr,
keeping stdout available for piping.

This format is useful when explicitly requesting table output in scripts or when the default text
output includes non-tabular content and a structured table view is preferred.

```bash
rfapps status --output table
rfmedia history --output table
```

### Text (`--output text`)

The default output format. Normal human-readable output with colored text, progress bars, and log
messages. This is the standard behavior when no `--output` flag is specified.

```bash
# These are equivalent
rfapps status
rfapps status --output text
```

## Output Structure Examples

The following examples show the same rfapps status data rendered in each format.

**Source data (two services):**

```bash
rfapps status --output <format>
```

**JSON:**

```json
{
  "timestamp": "2026-01-18T10:30:00.000Z",
  "services": [
    {
      "name": "traefik",
      "containerId": "abc123",
      "state": "running",
      "health": "healthy",
      "status": "Up 5 days",
      "ports": ["80:80", "443:443"],
      "image": "traefik",
      "tag": "v3.0"
    },
    {
      "name": "plex",
      "containerId": "def456",
      "state": "running",
      "health": "healthy",
      "status": "Up 3 days",
      "ports": ["32400:32400"],
      "image": "plexinc/pms-docker",
      "tag": "latest"
    }
  ],
  "total": 35,
  "running": 33,
  "healthy": 32
}
```

**YAML:**

```yaml
timestamp: "2026-01-18T10:30:00.000Z"
services:
  - name: traefik
    containerId: abc123
    state: running
    health: healthy
    status: Up 5 days
    ports:
      - "80:80"
      - "443:443"
    image: traefik
    tag: v3.0
  - name: plex
    containerId: def456
    state: running
    health: healthy
    status: Up 3 days
    ports:
      - "32400:32400"
    image: plexinc/pms-docker
    tag: latest
total: 35
running: 33
healthy: 32
```

**CSV:**

```csv
name,containerId,state,health,status,ports,image,tag
traefik,abc123,running,healthy,Up 5 days,"[""80:80"",""443:443""]",traefik,v3.0
plex,def456,running,healthy,Up 3 days,"[""32400:32400""]",plexinc/pms-docker,latest
```

**Table:**

```
NAME       STATE     HEALTH    IMAGE                  TAG
traefik    running   healthy   traefik                v3.0
plex       running   healthy   plexinc/pms-docker     latest
```

**Text:**

```
Service Status (2 services)

  traefik     running   healthy   traefik:v3.0           Up 5 days
  plex        running   healthy   plexinc/pms-docker:latest   Up 3 days

Summary: 35 total, 33 running, 32 healthy
```

## Parsing Machine Output

### JSON with jq

[jq](https://stedolan.github.io/jq/) is the recommended tool for parsing JSON output:

```bash
# Get list of running services
rfapps status --output json | jq -r '.services[] | select(.state == "running") | .name'

# Count unhealthy services
rfapps status --output json | jq '.services | map(select(.health == "unhealthy")) | length'

# Get services with specific health status
rfapps status --output json | jq '.services[] | select(.health == "starting")'

# Extract container IDs
rfapps status --output json | jq -r '.services[].containerId'

# Get total running count
rfapps status --output json | jq '.running'

# rfmedia: get operation success rates
rfmedia stats --output json | jq '.result.operations[] | {command, successRate}'
```

### YAML with yq

[yq](https://github.com/mikefarah/yq) is the recommended tool for parsing YAML output:

```bash
# Get list of running services
rfapps status --output yaml | yq '.services[] | select(.state == "running") | .name'

# Count total services
rfapps status --output yaml | yq '.total'

# Get service names as a list
rfapps status --output yaml | yq '.services[].name'

# rfmedia: get total files tracked
rfmedia stats --output yaml | yq '.result.totalFiles'

# Extract storage breakdown
rfmedia stats --output yaml | yq '.result.storageByRating'
```

### CSV with standard tools

CSV output can be processed with common command-line tools or imported directly into spreadsheet
applications:

```bash
# Extract service names (skip header, print first column)
rfapps status --output csv | tail -n +2 | cut -d',' -f1

# Filter running services
rfapps status --output csv | awk -F',' 'NR==1 || $3=="running"'

# Count services by state
rfapps status --output csv | tail -n +2 | cut -d',' -f3 | sort | uniq -c

# Import into Python for analysis
rfapps status --output csv | python3 -c "
import csv, sys
reader = csv.DictReader(sys.stdin)
for row in reader:
    if row['state'] != 'running':
        print(f\"Stopped: {row['name']}\")
"

# Save to file for spreadsheet import
rfapps status --output csv > services.csv
rfmedia history --output csv > history.csv
```

## Use Cases

### Monitoring Scripts

Use JSON with jq for service health monitoring:

```bash
#!/bin/bash
# health-check.sh

output=$(rfapps status --output json)
unhealthy=$(echo "$output" | jq '.services | map(select(.health == "unhealthy")) | length')

if [ "$unhealthy" -gt 0 ]; then
    services=$(echo "$output" | jq -r '.services[] | select(.health == "unhealthy") | .name' | tr '\n' ', ')
    curl -X POST "https://hooks.example.com/alert" \
         -H "Content-Type: application/json" \
         -d "{\"text\": \"Unhealthy services: $services\"}"
fi
```

### CI/CD Integration

Use JSON or YAML for deployment verification in CI pipelines:

```bash
#!/bin/bash
# deploy-verify.sh

# JSON for programmatic checks
rfapps deploy -g media-stack --output json --yes > deploy-result.json

failed=$(jq '.failed | length' deploy-result.json)
if [ "$failed" -gt 0 ]; then
    echo "Deployment failed for:"
    jq -r '.failed[] | "  - \(.name): \(.error)"' deploy-result.json
    exit 1
fi

echo "Deployment successful: $(jq '.started' deploy-result.json) services started"
```

```bash
#!/bin/bash
# deploy-verify-yaml.sh

# YAML for configuration-oriented pipelines
rfapps deploy -g media-stack --output yaml --yes > deploy-result.yaml

failed=$(yq '.failed | length' deploy-result.yaml)
if [ "$failed" -gt 0 ]; then
    echo "Deployment had failures"
    yq '.failed' deploy-result.yaml
    exit 1
fi
```

### Spreadsheet Export

Use CSV for importing service data into spreadsheets or reporting tools:

```bash
# Export service inventory to CSV
rfapps status --all --output csv > services.csv

# Export operation history to CSV
rfmedia history --output csv > operations.csv

# Export with date filtering
rfmedia history --from="7 days ago" --output csv > recent-operations.csv
```

### Log-Friendly Output

Use text or table for human-readable output in log files:

```bash
# Append status to daily log
rfapps status --output text >> /var/log/rfapps/daily-status.log

# Table format for structured log entries
rfapps status --output table 2>> /var/log/rfapps/status-table.log
```

## Combining with Other Options

Output formats can be combined with other global options, subject to command-specific
restrictions:

```bash
# With --dry-run
rfapps deploy -s plex --output json --dry-run
rfapps rebuild -s traefik --output yaml --dry-run
rfapps audit -s traefik --output json

# With read-only deploy conflict validation
rfapps deploy -s plex --validate-first --output json --dry-run

# With --debug (debug output goes to stderr, data to stdout)
rfapps status --output json --debug

# With --yes (skip confirmation prompts)
rfapps deploy -g media-stack --output csv --yes
```

Machine-readable formats (`json`, `yaml`, `csv`) never prompt, but selecting one does not grant
consent or imply `--yes`. Each command owns its approval policy. For example,
`rfmedia reconcile apply --execute` in machine or non-interactive mode requires an explicit
`--yes`; without it, the command rejects the request before mutation. This does not bypass
`rfapps deploy --validate-first`: `blocked` and `inconclusive` validation outcomes still exit `1`
before mutation. `rfapps backup` creation in JSON or YAML mode requires both an explicit target or
`--all` and `--yes`, including dry-run. Offline `rfapps backup verify` never prompts.

### Deploy Conflict Validation Results

For `rfapps deploy --validate-first`, JSON and YAML emit exactly one command result. The optional
`validation` property contains the complete `conflict-validation.v1` result with a `passed`,
`blocked`, or `inconclusive` status. The property is absent when the flag is not used, preserving
the existing deploy output contract.

A valid blocked or inconclusive preflight exits `1` and still emits that one structured document;
inspect `validation.status`, stable validation codes, and the deploy result's `failed` array.
Invalid invocations, including `--output csv --validate-first`, exit `2` before a result can be
constructed and leave stdout empty.

### Native Backup Results

Backup creation uses one terminal `rfapps-backup-result.v1` document in JSON and YAML. It preserves
the requested/resolved/writer scopes, destination and published paths, planned/skipped/artifact
outcomes, warnings and errors, exact-container recovery failures, staging disposition, and summary
counts. Dry-run reports `status: "planned"` without a bundle. A successful real creation reports
`status: "succeeded"` and `stagingDisposition: "published"`.

Offline verification uses one terminal `rfapps-backup-verify-result.v1` document. It preserves every
declared and unexpected artifact outcome plus verified, missing, unsafe, size-mismatch, and
checksum-mismatch counts. Verification does not load rfapps config, contact Docker, acquire a lock,
or extract an archive.

Text and table render human summaries of the same typed facts. The reviewed creation plan,
progress, and diagnostics are written to stderr; JSON and YAML reserve stdout for exactly one
terminal result. CSV is rejected rather than dropping nested evidence.

| Code | Creation                                                       | Verification                                      |
| ---- | -------------------------------------------------------------- | ------------------------------------------------- |
| `0`  | Dry-run completed, or bundle published and writers recovered   | Every declared artifact verified                  |
| `1`  | Docker, filesystem, archive, cleanup, or recovery failure      | Missing, unexpected, size, or checksum failure    |
| `2`  | Invalid/unsafe usage, unsupported input, or cancelled approval | Invalid, unsafe, or unsupported manifest or usage |

See [rfapps Native Backup](rfapps-backup.md) and [JSON Output](json-output.md#native-backup-commands)
for the complete contracts and examples.

### Staged Rollout Results

For `rfapps deploy --staged`, JSON and YAML add an optional `staged` object to the deploy result:

| Property           | Type                                        | Meaning                                  |
| ------------------ | ------------------------------------------- | ---------------------------------------- |
| `status`           | `"completed"` \| `"halted"` \| `"degraded"` | Terminal rollout state                   |
| `batchSize`        | number                                      | Resolved `--batch-size`                  |
| `onFailure`        | `"halt"` \| `"continue"`                    | Resolved `--on-failure`                  |
| `totalBatches`     | number                                      | Planned batches, including skipped ones  |
| `completedBatches` | number                                      | Batches that passed their gate           |
| `haltedAtBatch`    | number, optional                            | Present only when `status` is `"halted"` |

Six services at `--batch-size 2` plan three batches, and the rollout below halts at batch 2:

```bash
rfapps deploy --services homarr,ofelia,stirling-pdf,uptime-kuma,docktail,traefik \
  --staged --batch-size 2 --output yaml --yes
```

```yaml
services:
  - homarr
  - ofelia
  - stirling-pdf
  - uptime-kuma
  - docktail
  - traefik
failed:
  - name: uptime-kuma
    code: STAGE_GATE_FAILED
    error: "Batch 2 failed (gate-timeout): not-running"
  - name: docktail
    code: STAGE_NOT_ATTEMPTED
    error: "Not attempted: staged rollout halted after batch 2 of 3"
  - name: traefik
    code: STAGE_NOT_ATTEMPTED
    error: "Not attempted: staged rollout halted after batch 2 of 3"
healthy:
  - homarr
  - ofelia
  - stirling-pdf
unhealthy:
  - uptime-kuma
started: 4
staged:
  status: halted
  batchSize: 2
  onFailure: halt
  totalBatches: 3
  completedBatches: 1
  haltedAtBatch: 2
```

Batching chunks the blast-radius ordering linearly, so `totalBatches` is always
`ceil(<resolved services> / batchSize)`: every batch holds exactly `batchSize` services except a
possibly short final batch. Every member of a batch that never ran because the rollout halted
appears in `failed[]` with code `STAGE_NOT_ATTEMPTED`, so `haltedAtBatch: 2` out of
`totalBatches: 3` always leaves batch 3's services in `failed[]`.

The property is absent when `--staged` is not used, preserving the existing deploy output contract.
It is **stripped from both `table` and `csv`**, which flatten the deploy result to a fixed column
set; unlike `--validate-first`, this is a silent omission rather than a usage error. Per-service
outcomes stay in `failed[]`, `healthy[]`, and `unhealthy[]` in every format, and the failing batch
and cause remain readable in each `failed[].error` string.

`--staged --dry-run` is different: it emits a batch **plan** under `staged` that is kept in `csv`
too, with `staged.batches` serialized as a JSON string cell. See
[Dry-Run Mode](dry-run-mode.md#combining-dry-run-with-staged-rollouts).

### Tag List Table

`rfapps tag list --output table` renders the taxonomy as a flat four-column view, one row per
effective tag:

| Column     | Meaning                                                                    |
| ---------- | -------------------------------------------------------------------------- |
| `tag`      | The full effective tag path, ancestors included                            |
| `depth`    | Number of segments (`media/automation/tv` is depth 3)                      |
| `services` | The services carrying that tag effectively                                 |
| `count`    | `services.length`, so a table can be sorted by breadth without re-counting |

```bash
rfapps tag list --output table
```

Rows are ordered by tag path, so a parent always precedes its children and the flat view still reads
as a hierarchy. `rfapps tag show --output table` uses `service | declared | effective` for the same
reason. Both tables are lossy relative to `--output json`: the `declared` flag that distinguishes an
authored tag from a derived ancestor survives only in JSON and YAML.

`--output text` (the default) prints the same data as an aligned listing, and `--tree` renders it as
an indented hierarchy with the source configuration layer on stderr. `--output csv` is refused on
both subcommands — see [CSV](#csv---output-csv).

## Both CLIs

The `--output` flag is supported identically in both rfapps and rfmedia:

| Feature             | rfapps                       | rfmedia                      |
| ------------------- | ---------------------------- | ---------------------------- |
| `--output <format>` | Yes                          | Yes                          |
| `--json` (legacy)   | Yes                          | Yes                          |
| Format choices      | json, yaml, csv, table, text | json, yaml, csv, table, text |
| Default format      | text                         | text                         |
| Log suppression     | json, yaml, csv              | json, yaml, csv              |
| Long-only (no `-o`) | Yes                          | Yes                          |

Both CLIs share the same `@rfmedia/common` infrastructure for output format state management
(`setOutputFormat`, `getOutputFormat`, `isMachineFormat`) and generic serializers
(`formatMachineOutput` with lazy-loaded JSON, YAML, and CSV formatters).

## Dynamic Table Width Policy

Human-readable table output (`--output table` and `text`) adapts to the terminal width using a
shared width-policy pattern. This applies only to human-readable formats; machine-readable formats
(JSON, YAML, CSV) are unaffected.

### TTY Detection

Tables detect the output stream width at render time:

```typescript
if (stream.isTTY && typeof stream.columns === "number" && stream.columns > 0) {
  return stream.columns;
}
return FALLBACK_TABLE_COLUMNS; // 120
```

- **stdout**: Used by rfapps `renderTable` and rfmedia `formatPlaylistListResults`
- **stderr**: Used by rfapps `history` (which writes to stderr via `console.error`)
- **Fallback**: `FALLBACK_TABLE_COLUMNS = 120` when `isTTY` is false (CI, piped output, redirected
  streams)

### Column Budgeting

Tables use a fixed-vs-flex column budget model:

1. **Fixed columns** reserve their minimum width first (e.g., Tracks, Smart, Duration, Status, ID)
2. **Flex columns** (e.g., Name, Service, Image Tag) share the remaining width
3. Every column has a minimum width to prevent complete collapse on narrow terminals

```text
Total terminal width
  - row prefix (indent)
  - column gaps (spacing between columns)
  - fixed column budgets
  = remaining width for flex columns
```

### Truncation

- **Strategy**: Single-line truncation with ellipsis marker (no wrapping)
- **Library**: `cli-truncate` for Unicode-safe truncation
- **Safety**: A secondary pass catches the rare case where `cli-truncate` overflows by 1 column at
  fullwidth character boundaries

### Width Measurement

- **Library**: `string-width` for visual display width measurement
- **Replaces**: Raw `.length` which miscounts fullwidth characters (CJK), emoji, and ANSI escape
  codes
- **Padding**: Custom `padToWidth()` functions replace `String.padEnd()` to account for display
  width vs code unit length

### Where the Pattern Lives

| CLI     | File                          | Role                                                                                                        |
| ------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| rfmedia | `src/lib/terminal-table.ts`   | Shared width-policy utility: `getTerminalWidth`, `calculateColumnWidths`, `truncateToWidth`, `displayWidth` |
| rfmedia | `src/lib/table-format.ts`     | Dry-run preview tables using `truncateToWidth` and `displayWidth` from terminal-table                       |
| rfmedia | `src/lib/format.ts`           | `truncateDisplay()` convenience wrapper delegating to `truncateToWidth`                                     |
| rfapps  | `src/lib/formatters/table.ts` | Centralized table renderer with inline width-policy helpers                                                 |
| rfapps  | `src/actions/history.ts`      | History-specific table with fixed/flex budget and `stderr` width detection                                  |

### Adopting the Pattern for New Tables

To add a new dynamic table in either CLI:

1. **Define column types**: Mark each column as fixed (predictable content width) or flex (variable
   content)
2. **Set minimum widths**: Every column needs a minimum to prevent collapse
3. **Detect terminal width**: Use `getTerminalWidth()` (rfmedia) or the inline helper (rfapps)
4. **Allocate budgets**: Subtract fixed columns, row prefix, and gaps from terminal width;
   distribute the remainder to flex columns
5. **Truncate cells**: Use `truncateToWidth(text, width)` for Unicode-safe truncation
6. **Pad cells**: Use `padToWidth(text, width)` instead of `String.padEnd()` for correct alignment
7. **Test deterministically**: Mock `process.stdout.isTTY = false` to get the 120-column fallback in
   tests

## Related Documentation

- [Quick Reference](quick-reference.md) - One-page command reference card
- [rfapps CLI Reference](../reference/rfapps-cli-reference.md) - Complete command documentation
- [Shell Completion](shell-completion.md) - Tab completion setup
- [rfapps Native Backup](rfapps-backup.md) - Backup format, result, and CSV refusal contracts
- [Dry-Run Mode](dry-run-mode.md) - Preview actions without executing
- [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md) - `--scan` report shape and which
  formats carry it
- [rfapps Harden Command](rfapps-harden-command.md) - `harden.v1` result shape and format behaviour
- [rfapps Tag Selector](rfapps-tag-selector.md) - `tags.v1` result shape, the table view, and the CSV
  refusal
