# rfapps Harden Command

`rfapps harden` proposes security hardening changes for resolved Docker Compose services and can
write them either as a separate override fragment or, on explicit request, in place. It remediates
the same subject matter `rfapps lint` and `rfapps audit` report, with stable `harden-*` rule ids.

It is non-destructive by default. With no write flag it resolves compose configuration, reports what
it would change, prints an editable compose override fragment, and writes nothing. It never starts,
stops, recreates, or removes a container, never pulls an image, and never records deployment state.

## Command Syntax

```text
rfapps harden [options]
```

| Option                  | Meaning                                                 |
| ----------------------- | ------------------------------------------------------- |
| `-s, --service <name>`  | Target one service                                      |
| `--services <names>`    | Target comma-separated services                         |
| `-g, --group <name>`    | Target a configured service group                       |
| `--no-sidecars`         | Disable automatic sidecar expansion                     |
| `--apply`               | Edit `compose.yml` in place after confirmation          |
| `-o, --out <path>`      | Write a compose override fragment to `<path>`           |
| `--include-review`      | Include review-confidence rules in written output       |
| `--rule <ids>`          | Restrict to a comma-separated rule allowlist            |
| `--list-rules`          | Print the rule catalog and exit                         |
| `--no-backup`           | Skip the `compose.yml.bak` copy taken before `--apply`  |
| `--allow-reformat`      | Accept incidental YAML reformatting of untargeted lines |
| `-f, --compose <path>`  | Use a specific compose file                             |
| `-e, --env-file <path>` | Use a specific environment file                         |
| `-p, --profile <name>`  | Use a specific Docker Compose profile                   |
| `--json`                | Emit the harden result as JSON                          |

```bash
# Report proposals for a group and print the override fragment; write nothing
rfapps harden -g media-stack

# Print the rule catalog and exit
rfapps harden --list-rules

# Write a non-destructive override, then deploy through it
rfapps harden --out compose.harden.yaml
docker compose -f compose.yml -f compose.harden.yaml up -d

# Narrow to a single rule
rfapps harden --rule harden-no-new-privileges --out compose.harden.yaml

# Edit compose.yml in place after a confirmation prompt
rfapps harden -s sonarr --apply

# Widen to review-confidence rules and accept serialization churn, unattended
rfapps harden -s sonarr --apply --include-review --allow-reformat --yes

# Machine-readable summary
rfapps harden --json | jq '.summary'
```

The following combinations are rejected as usage errors (exit 2): `--apply` with `--out`, because
they are two different write modes; `--allow-reformat` without `--apply`, and `--no-backup` without
`--apply`, because neither has any meaning when nothing is rewritten; `--apply` with machine output
and without `--yes`, because a prompt cannot be answered in a JSON pipeline. `--out` refuses to
overwrite an existing file. The global `--dry-run` suppresses every write in both write modes and
exits 0. **`--include-review` is legal in every mode** — in propose mode it widens the override
fragment that gets printed.

"Machine output" above means exactly the machine formats `json`, `yaml`, and **`csv`** (plus
`--json`). The `--yes` guard and the confirmation prompt read that one definition, so no format can
skip both: `text` and `table` are prompted, and the three machine formats are refused without
`--yes`. Nothing reaches the destructive path unconfirmed.

`--apply` takes the same rfapps state-mutation lock that `rfapps drift import` takes, because both
write `compose.yml`. Propose mode and `--out` take no lock.

Rule selection and suppression come from the `harden:` section of `rfapps.config.yaml`:

```yaml
harden:
  includeReview: false
  backup: true
  ignore:
    - rule: harden-memory-limit
      service: plex # GPU workload; limits are host-dependent
    - rule: harden-run-as-non-root
      service: traefik # binds :80/:443
```

`rule` accepts a `harden-*` id or `*`, and `service` is optional. `reason` is optional here, unlike
scan suppressions: suppressing "add a healthcheck" needs no justification trail, while accepting a
known CVE does. `harden.rules` narrows the catalog the same way `--rule` does, and `--rule` wins when
both are present. An unknown rule id is a usage error (exit 2). There are no `RFAPPS_HARDEN_*`
environment overrides.

## Detection and Patching Inputs

**Detection** reads the fully resolved compose model, exactly like `rfapps audit` — anchors,
`extends`, and `${VAR}` interpolation are already flattened. That is what stops harden from proposing
something a shared anchor already supplies.

**Patching** reads and edits the _source_ `compose.yml` through a comment- and anchor-preserving YAML
document, the same path `rfapps drift import` uses. The consequence is worth stating explicitly: a
proposal can be correctly detected against the resolved model and still be refused for automated
writing, because the source document supplies that key through a shared anchor. Refusals are computed
in **every** mode, so propose mode shows exactly the refusals `--apply` would hit.

## Rule Catalog

| Rule ID                    | Severity | Category     | Confidence | Fires when                                    | Proposed change                                                                                                                                    |
| -------------------------- | -------- | ------------ | ---------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harden-no-new-privileges` | `info`   | capabilities | safe       | `security_opt` lacks `no-new-privileges:true` | Union `no-new-privileges:true` into `security_opt`                                                                                                 |
| `harden-restart-policy`    | `warn`   | availability | safe       | No `restart` and no `deploy.restart_policy`   | `restart: unless-stopped`                                                                                                                          |
| `harden-log-rotation`      | `warn`   | logging      | safe \*    | `logging.options["max-size"]` absent or empty | Whole `logging` map, rebuilt from the existing block: current driver and options preserved, `max-size: 10m` added, `max-file: "3"` only when unset |
| `harden-cap-drop-all`      | `info`   | capabilities | review     | `cap_drop` does not include `ALL`             | Union `ALL` into `cap_drop`                                                                                                                        |
| `harden-read-only-rootfs`  | `info`   | filesystem   | review     | `read_only` is not `true`                     | `read_only: true`                                                                                                                                  |
| `harden-run-as-non-root`   | `warn`   | identity     | review     | `user` absent, `0`, `root`, or `0:*`          | `user: "${PUID}:${PGID}"`                                                                                                                          |
| `harden-healthcheck`       | `warn`   | health       | advisory   | `healthcheck` absent or null                  | None — guidance only                                                                                                                               |
| `harden-memory-limit`      | `info`   | limits       | advisory   | `deploy.resources.limits.memory` absent/empty | None — guidance only                                                                                                                               |
| `harden-cpu-limit`         | `info`   | limits       | advisory   | `deploy.resources.limits.cpus` absent/empty   | None — guidance only                                                                                                                               |

\* `harden-log-rotation` writes through `set`, which replaces the whole `logging` map, so the patch is
rebuilt from the service's resolved block rather than hardcoded: an existing `driver` and every
existing option survive, and only `max-size` is added (`max-file` is defaulted to `"3"` when the
service does not already set it). `max-size` is a `json-file`/`local` option, so on any other driver
(`syslog`, `journald`, `fluentd`, `gelf`, …) the rule drops to **`advisory`** and proposes no patch at
all — rotation there is configured at the driver, and rfapps will not silently move where the logs go.
The rule stays `safe` only when the driver is absent or already rotation-capable.

Why each one matters:

- `harden-no-new-privileges` — a setuid binary inside the container can still escalate privileges.
- `harden-restart-policy` — without one, the container stays stopped after a host reboot.
- `harden-log-rotation` — unbounded container logs fill the disk and take down every service.
- `harden-cap-drop-all` — dropping everything and re-adding what is used minimises post-compromise
  capability.
- `harden-read-only-rootfs` — a writable root filesystem lets a compromised process persist changes.
- `harden-run-as-non-root` — a root process shares uid 0 with the host.
- `harden-healthcheck` — orchestrators cannot detect or replace a container they cannot probe.
- `harden-memory-limit` — one runaway service can OOM the whole host.
- `harden-cpu-limit` — an unbounded service can starve every other container.

Each rule declares the lint or audit finding it remediates, so the catalogs stay coherent:

```text
harden-no-new-privileges  <- lint/no-new-privileges-missing
harden-restart-policy     <- lint/restart-policy-missing
harden-log-rotation       <- lint/log-rotation-missing
harden-cap-drop-all       <- lint/cap-drop-missing, audit/cap-drop-missing
harden-read-only-rootfs   <- lint/read-only-rootfs
harden-run-as-non-root    <- audit/root-user
harden-healthcheck        <- lint/healthcheck-missing
harden-memory-limit       <- lint/resource-limits-missing, audit/memory-limit-missing
harden-cpu-limit          <- audit/cpu-limit-missing
```

`harden-cap-drop-all` and `harden-read-only-rootfs` attach an extra caution note when the service
adds capabilities, maps devices, or has writable bind mounts. `rfapps lint` and `rfapps audit` remain
the reporting commands; harden changes neither catalog nor their output.

## Safe, Review, and Advisory

| Confidence | Written by                                  | Meaning                                       |
| ---------- | ------------------------------------------- | --------------------------------------------- |
| `safe`     | `--apply` and `--out` by default            | Mechanical and workload-neutral               |
| `review`   | `--apply` / `--out` with `--include-review` | Can break the workload; verify it first       |
| `advisory` | Never written, in any mode                  | No safe automatic value exists; guidance only |

rfapps will not invent a health-check probe command, a memory ceiling, or a CPU ceiling. A wrong
probe marks a healthy service unhealthy; a wrong ceiling OOM-kills it. Those three ship as detection
plus guidance by deliberate scope decision, not because the write path is missing.

## Propose, Override, and Apply

| Mode       | Selected by    | Writes                                                         |
| ---------- | -------------- | -------------------------------------------------------------- |
| `propose`  | no write flag  | Nothing; prints the report and the override fragment           |
| `override` | `--out <path>` | The fragment at `<path>`, exclusively; `compose.yml` untouched |
| `apply`    | `--apply`      | `compose.yml` in place, after a `.bak` copy and a prompt       |

- Mode is derived from flags; it is never passed as a value.
- `--apply` with nothing writable logs `No writable patches; compose.yml unchanged`, writes nothing,
  and still reports `mode: "apply"` with exit 0.
- Cancelling the confirmation prompt exits 0, matching `rfapps drift import`. Declining a change is
  not a failure.
- `--no-backup` suppresses only the `.bak` copy and requires `--apply`.
- The in-place rewrite is **atomic**: the patched document is written to a temporary file beside
  `compose.yml`, given the original's mode, and moved into place with `rename(2)`. `compose.yml` is
  therefore always either the untouched original or the fully patched file, never a truncated mix —
  which matters most with `--no-backup`, where there is no recovery copy. If any step fails the
  temporary file is removed, the error names the untouched path, and the command exits 1.

Illustrative output, trimmed to one proposal per confidence level:

```text
Security Hardening Proposals  (mode: propose -- nothing written)
Compose: /srv/rfmedia-apps/compose.yml
Scope: plex, sonarr, radarr (profiles: media)
Proposals: 14 total - 6 safe, 5 review, 3 advisory | 2 suppressed | 4 refused

SAFE - write with `rfapps harden --apply`
  sonarr
    info  harden-no-new-privileges  security_opt += ["no-new-privileges:true"]
      evidence: security_opt does not include no-new-privileges:true
      detects: lint/no-new-privileges-missing

REVIEW - verify the workload first: `rfapps harden --apply --include-review`
  plex
    info  harden-read-only-rootfs  read_only = true
      evidence: read_only is not true
      note: writable bind mounts detected; provide tmpfs or volume mounts for every writable path first
      detects: lint/read-only-rootfs

ADVISORY - no safe automatic value exists
  plex
    warn  harden-healthcheck  (advisory - no automatic value)
      evidence: healthcheck absent
      guidance: Add a `healthcheck` block with a service-specific `test`, `interval`, `timeout`, `retries`, and `start_period`. rfapps will not invent a probe command; a wrong probe marks a healthy service unhealthy.
      detects: lint/healthcheck-missing

REFUSED - reported, not written
  sonarr  harden-log-rotation  services.sonarr.logging is a YAML alias (*logging-default); editing it would change every service that shares the anchor
  -> use: rfapps harden --rule harden-log-rotation --out compose.harden.yaml

Note: writing compose.yml would also reformat lines this command did not target
(line delta: -6). --apply requires --allow-reformat, or use --out.

Compose override fragment (usable as `docker compose -f compose.yml -f compose.harden.yaml up -d`):

# Generated by rfapps harden at 2026-07-30T18:00:00.000Z
# Source: /srv/rfmedia-apps/compose.yml
# Apply with: docker compose -f compose.yml -f compose.harden.yaml up -d
# Safe-confidence rules only. Re-run with --include-review to include review rules.
services:
  sonarr:
    security_opt:
      - no-new-privileges:true
```

The suppressed count appears only inside the `Proposals:` line; there is no separate suppression
section. Under `--apply` the header and the closing lines change, and the override fragment is not
printed:

```text
Security Hardening  (mode: apply)
Backup: /srv/rfmedia-apps/compose.yml.bak
Applied 6 patch(es) to 4 service(s); 5 review and 3 advisory proposal(s) untouched.
Refused 4 patch(es) (see above). Exit code 3 (partial).
```

There is deliberately no unified diff. The `SAFE` and `REVIEW` blocks name every key and value that
would be written, the override fragment renders them as literal YAML, and serialization churn is
disclosed as a count rather than buried in diff noise.

## Override Fragment Semantics

> A compose override **replaces** a sequence rather than appending to it. Every sequence-valued patch
> therefore emits the **full union** computed from the resolved configuration, not just the entry
> being added. Emitting only the addition would silently drop an existing `security_opt` or `cap_add`
> entry — a hardening tool weakening security.

The fragment carries a generated header naming the source file, the timestamp, the
`docker compose -f compose.yml -f compose.harden.yaml up -d` invocation, and whether review rules
were included. It contains only writable proposals; advisory rules never appear in it. `--out` writes
exclusively and fails if the path already exists. The same text is available from the JSON result's
`override` field, so CI can run `rfapps harden --json | jq -r '.override' > compose.harden.yaml`.

## YAML Anchor Refusals

| Code              | Cause                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| `alias-target`    | The target key is a YAML alias; editing it would change every sharer    |
| `service-missing` | The service is absent from the compose document being patched           |
| `unexpected-node` | The existing node is not the kind the operation requires                |
| `nested-path`     | Defensive: a patch declared a nested path, which is forbidden by design |

A refusal is reported and non-fatal. Detection stands; only the automated write is withheld, and the
alternative is always named — usually `rfapps harden --rule <id> --out compose.harden.yaml`. Writing
a **new top-level key** on a service that merges an anchor (`<<: *service-base`) is safe and does not
touch the anchor, so that case is not refused. Harden never writes through a nested path by design; a
rule that would need one ships as advisory instead.

The guard covers **both sides of a shared anchor**, because either side reconfigures services the
command was never told to touch:

- **Alias side** — the target key _is_ an alias (`logging: *logging-default`). Refused with
  `services.<svc>.<key> is a YAML alias (*logging-default); editing it would change every service
that shares the anchor`.
- **Anchor side** — the target key, the service map, or the `services` map _carries_ an anchor that
  something else aliases or `<<:`-merges (`security_opt: &secopt`). Refused with
  `services.<svc>.<key> is inside the anchored node &secopt; …`. Without this, patching one service
  would silently rewrite every sharer, and replacing an anchored node would orphan the surviving
  aliases and make the result fail to re-serialize.

An anchor nothing references is not shared, so it is patched normally. Refusals are reported, never
thrown: propose mode and `--out` stay read-only and never surface a raw YAML error on legal input.

In this deployment the shared logging anchor already sets a `max-size`, so `harden-log-rotation` does
not fire on the services that use it; the guard exists for whichever compose file supplies a targeted
key through a shared anchor.

## Reformat Acknowledgement

Every mode computes and reports whether re-serializing the source document would change lines this
command did not target, and by how many. When it would, `--apply` refuses with a usage error (exit 2)
naming `--allow-reformat` and `--out`. Nothing is ever silently reformatted.

The refusal is scoped to the invocation that actually rewrites the file. `--dry-run` still exits 0,
and so does an `--apply` with nothing writable — neither performs a write, so neither is blocked for
churn it would never cause. The informational `Note:` line about the line delta is emitted in every
mode regardless, so the churn is disclosed either way.

On this repository the canonical serializer collapses one prettier-wrapped flow sequence
(`authentik-server.healthcheck.test`) onto a single line — a six-line reduction in exactly one region.
So `--apply` here needs `--allow-reformat` once, or a one-time reflow of that block, after which the
acknowledgement stops being required.

## Idempotency

`rfapps harden --apply` run twice is a no-op. Sequence-valued patches union rather than overwrite, so
re-applying neither duplicates an entry nor clobbers an existing one, and scalar patches are only
proposed while the value is missing. Each rule's own proposal is what makes that rule stop firing for
that service.

## Machine Result Contract

`--json` (or the global `--output json` / `--output yaml`) emits exactly one `harden.v1` document on
stdout; human text and diagnostics stay on stderr. `table` and `csv` flatten the top level and are not
a substitute — `proposals`, `refusals`, and `override` are JSON and YAML detail. `harden` is not
exposed through the MCP server, like `lint`, `audit`, and `doctor`.

The document carries `schemaVersion`, `timestamp`, `mode`, `includeReview`, `scope`, `summary`,
`proposals`, `refusals`, `reformat`, `override`, and `write`.

```json
{
  "schemaVersion": "harden.v1",
  "timestamp": "2026-07-30T18:00:00.000Z",
  "mode": "propose",
  "includeReview": false,
  "scope": {
    "services": ["plex", "sonarr", "radarr"],
    "profiles": ["media"],
    "composePath": "/srv/rfmedia-apps/compose.yml"
  },
  "summary": {
    "total": 14,
    "safe": 6,
    "review": 5,
    "advisory": 3,
    "suppressed": 2,
    "servicesAffected": 3,
    "applied": 0,
    "refused": 4
  },
  "proposals": [
    {
      "ruleId": "harden-no-new-privileges",
      "service": "sonarr",
      "category": "capabilities",
      "severity": "info",
      "confidence": "safe",
      "title": "no-new-privileges not set",
      "rationale": "A setuid binary inside the container can still escalate privileges.",
      "guidance": "Add `security_opt: [\"no-new-privileges:true\"]` unless the service requires privilege escalation.",
      "detects": { "lint": "no-new-privileges-missing" },
      "evidence": ["security_opt does not include no-new-privileges:true"],
      "patches": [
        {
          "key": "security_opt",
          "operation": "merge-unique",
          "value": ["no-new-privileges:true"],
          "description": "security_opt += [\"no-new-privileges:true\"]"
        }
      ]
    },
    {
      "ruleId": "harden-healthcheck",
      "service": "plex",
      "category": "health",
      "severity": "warn",
      "confidence": "advisory",
      "title": "Health check missing",
      "rationale": "Without a health check, orchestrators cannot detect or replace an unhealthy container.",
      "guidance": "Add a `healthcheck` block with a service-specific `test`, `interval`, `timeout`, `retries`, and `start_period`.",
      "detects": { "lint": "healthcheck-missing" },
      "evidence": ["healthcheck absent"],
      "patches": []
    }
  ],
  "refusals": [
    {
      "code": "alias-target",
      "service": "sonarr",
      "ruleId": "harden-log-rotation",
      "detail": "services.sonarr.logging is a YAML alias (*logging-default); editing it would change every service that shares the anchor",
      "alternative": "use: rfapps harden --rule harden-log-rotation --out compose.harden.yaml"
    }
  ],
  "reformat": { "wouldReformat": true, "lineDelta": -6 },
  "override": "# Generated by rfapps harden at 2026-07-30T18:00:00.000Z\nservices:\n  sonarr:\n    security_opt:\n      - no-new-privileges:true\n",
  "write": { "mode": "propose" }
}
```

`lineDelta` is the canonical serialization's line count minus the source's, so it is negative when
re-serializing collapses lines.

In apply mode `write` becomes
`{ "mode": "apply", "path": "…/compose.yml", "backupPath": "…/compose.yml.bak", "patchesWritten": 6, "servicesPatched": ["radarr", "sonarr"] }`,
and in override mode `{ "mode": "override", "path": "…", "patchesWritten": 6 }`.

Output is deterministic: proposals sort by confidence, then service, then catalog order; patches keep
declaration order; refusals sort by service, then rule id.

## Exit Codes

| Code | Meaning                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ |
| `0`  | Proposals reported, override written, apply completed, or apply cancelled at the prompt                |
| `1`  | Compose resolution failed, or the backup/write failed                                                  |
| `2`  | Usage error, including `--apply` needing `--allow-reformat`, `--out` on an existing file, unknown rule |
| `3`  | Apply wrote some patches and refused others                                                            |

Harden is never a findings gate and has no `--fail-on`. Refusing to make an unsafe edit is correct
behaviour, and reporting that as a failure would train operators to ignore the exit code. Use
`rfapps lint --fail-on` when a CI threshold on this subject matter is wanted.

## Limitations

- No unified diff and no `git apply`-compatible patch.
- No synthesised health-check probe, memory limit, or CPU limit.
- No automated removal of `privileged: true`.
- No user-defined rules or presets. `--rule`, `harden.ignore`, and `--include-review` are the entire
  selection surface.
- No MCP tool. A compose-file mutator reachable without the confirmation prompt is a different risk
  conversation.
- Patches only write top-level keys under a service.
- `--apply` edits the single compose file rfapps resolved; services defined elsewhere are reported as
  `service-missing`, with `--out` named as the alternative.

## Related Documentation

- [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md)
- [rfapps Audit Command](rfapps-audit-command.md)
- [rfapps Doctor Command](rfapps-doctor-command.md)
- [rfapps Drift Command](rfapps-drift-command.md)
- [rfapps Configuration](rfapps-configuration.md)
- [Docker Compose Extensions](docker-compose-extensions.md)
- [rfapps CLI Reference](../../packages/rfapps-cli/README.md#harden)
- [Output Formats](output-formats.md)
- [JSON Output](json-output.md)
- [Error Handling](error-handling.md)
