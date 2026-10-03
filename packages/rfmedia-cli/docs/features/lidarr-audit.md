# Lidarr Library Health Audit

## Overview

`rfmedia lidarr audit` is a strictly read-only diagnostic over one Lidarr instance. It answers a
single question — "is this library healthy, and if not, what exactly is wrong?" — and never writes:
no monitoring edits, no profile assignments, no deletions, no plan artifacts, no cache population,
no Plex scan trigger.

```bash
rfmedia lidarr audit
rfmedia lidarr audit --check retry-backlog,duplicate-identity
rfmedia lidarr audit --deep --artist-ids 12,34
rfmedia lidarr audit --output json --fail-on warning
```

Eight checks are declared in one frozen registry. Each declares the data it `requires` (a hard gate)
and what it `enriches` (fetched when possible, never gating), and that registry is the single source
of truth for both what the command retrieves and whether a check can run. Selecting fewer checks
therefore costs fewer requests — see [Selection and Request Cost](#selection-and-request-cost).

Human output goes to stderr; machine output (`--output json|yaml|csv`, or the global `--json`) goes
to stdout. The command is diagnostic by default: even a critical finding leaves the exit code at 0.
`--fail-on <level>` is the explicit, opt-in CI gate.

## Severity Ladder

The audit uses its own three-rung ladder, ascending:

| Severity   | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `info`     | Worth knowing; frequently intentional. Not a defect on its own.         |
| `warning`  | Real drift or dead work; acquisition or import is degraded somewhere.   |
| `critical` | The instance, its metadata dependency, or its identity model is broken. |

This ladder is deliberately distinct from the two neighbouring vocabularies:

- `LidarrRiskLevel` (`src/types/lidarr-plan.ts`) rates the blast radius of a _proposed mutation_ in
  the plan/apply workflow. The audit proposes nothing, so it cannot reuse it.
- `LidarrHealthType` (`src/types/lidarr.ts`) is Lidarr's own wire severity. It is **translated**,
  never adopted: `error` becomes `critical`, `warning` becomes `warning`, `notice` becomes `info`,
  and `ok` emits nothing. The mapping is total over all four wire values and is test-enforced.

## Check Catalog

Seven checks are active in this release; `plex-alignment` ships as a reserved slot (see
[Reserved plex-alignment Slot](#reserved-plex-alignment-slot)).

| Check                 | Max severity | Requires / enriches            | Detects                                                        |
| --------------------- | ------------ | ------------------------------ | -------------------------------------------------------------- |
| `metadata-dependency` | `critical`   | `health`                       | Lidarr unreachable; metadata/Skyhook provider outage           |
| `operation-safety`    | `critical`   | `health`, `artists`            | Lidarr's own health checks; artists with no root folder        |
| `retry-backlog`       | `critical`   | `queue`                        | Open/half-open circuits; failed and pending deferred intents   |
| `monitoring-drift`    | `warning`    | `artists`, `albums`            | Album monitoring that contradicts its owning artist            |
| `library-gaps`        | `warning`    | `artists`, `wanted` / `albums` | Monitored entities with no files; the wanted/missing backlog   |
| `duplicate-identity`  | `critical`   | `artists` / `albums`           | Repeated MusicBrainz ids, shared paths, folded-name collisions |
| `plex-connectivity`   | `critical`   | `plex`                         | Media-server reachability and music-library resolution         |
| `plex-alignment`      | `warning`    | `plex`, `plexIdentity`         | **Reserved.** Never emits a finding; always skips.             |

`maxSeverity` is documentation and rendering only. It is **not** a gate on `--fail-on` — see the
note under [Exit Codes and CI](#exit-codes-and-ci).

`metadata-dependency` and `operation-safety` read the same health payload, and the
metadata-provider checks inside it belong to `metadata-dependency` — but only while that check is
actually selected. Under a narrowed selection such as `--check operation-safety`,
`operation-safety` reports those checks itself, so a metadata/Skyhook outage still trips a CI run
that deselected `metadata-dependency`. No selection can make a provider outage disappear from the
report, and no selection reports it twice.

## Finding Codes

Every finding carries a stable, kebab-case `code`, unique within its check. Codes are a public
contract: CI jobs grep them, and each check's complete code list is republished on its registry
descriptor so a new code cannot ship untyped. Twenty-three codes exist today.

| Check                 | Code                                       | Severity                | Remediation command                                                                                                                |
| --------------------- | ------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `metadata-dependency` | `lidarr-unreachable`                       | `critical`              | `rfmedia lidarr health`                                                                                                            |
| `metadata-dependency` | `metadata-provider-outage`                 | `critical`              | `rfmedia lidarr health --type error`                                                                                               |
| `operation-safety`    | `lidarr-health-check`                      | translated from Lidarr  | `rfmedia lidarr health --type error --type warning`                                                                                |
| `operation-safety`    | `artist-missing-root-path`                 | `warning`               | `rfmedia lidarr list`                                                                                                              |
| `retry-backlog`       | `circuit-open`                             | `critical`              | `rfmedia lidarr health`                                                                                                            |
| `retry-backlog`       | `circuit-half-open`                        | `warning`               | `rfmedia lidarr health`                                                                                                            |
| `retry-backlog`       | `circuit-state-unknown`                    | `info`                  | `rfmedia lidarr health`                                                                                                            |
| `retry-backlog`       | `deferred-intents-failed`                  | `critical`              | `rfmedia lidarr health`                                                                                                            |
| `retry-backlog`       | `deferred-intents-pending`                 | `warning`               | `rfmedia lidarr health`                                                                                                            |
| `retry-backlog`       | `queue-detail-unavailable`                 | `info`                  | `rfmedia lidarr health`                                                                                                            |
| `monitoring-drift`    | `monitored-album-under-unmonitored-artist` | `warning`               | `rfmedia lidarr plan artist-monitoring --ids <id> --monitored --plan-file ./audit-artist-monitoring.plan.json`                     |
| `monitoring-drift`    | `monitored-artist-no-monitored-albums`     | `info`                  | `rfmedia lidarr plan album-monitoring --artist-ids <id> --types albums --monitored --plan-file ./audit-album-monitoring.plan.json` |
| `library-gaps`        | `artist-monitored-no-files`                | `warning`               | `rfmedia lidarr albums --artist-ids <id> --no-files`                                                                               |
| `library-gaps`        | `wanted-backlog`                           | `info`                  | `rfmedia lidarr wanted --page-size 50`                                                                                             |
| `library-gaps`        | `album-monitored-no-files`                 | `warning` (`--deep`)    | `rfmedia lidarr albums --artist-ids <id> --no-files`                                                                               |
| `library-gaps`        | `album-partial-files`                      | `info` (`--deep`)       | `rfmedia lidarr albums --artist-ids <id> --no-files`                                                                               |
| `duplicate-identity`  | `duplicate-artist-mbid`                    | `critical`              | `rfmedia lidarr lookup artist "lidarr:<mbid>"`                                                                                     |
| `duplicate-identity`  | `duplicate-artist-path`                    | `warning`               | `rfmedia lidarr list`                                                                                                              |
| `duplicate-identity`  | `similar-artist-name`                      | `info`                  | `rfmedia lidarr list`                                                                                                              |
| `duplicate-identity`  | `duplicate-album-mbid`                     | `info` (`--deep`)       | `rfmedia lidarr lookup album "lidarr:<mbid>"`                                                                                      |
| `plex-connectivity`   | `plex-unreachable`                         | `critical` or `warning` | `rfmedia plex playlist list`                                                                                                       |
| `plex-connectivity`   | `plex-no-music-library`                    | `warning`               | `rfmedia plex playlist list`                                                                                                       |
| `plex-connectivity`   | `plex-library-name-unresolved`             | `warning`               | `rfmedia plex playlist list`                                                                                                       |

Notes on the non-obvious rows:

- `plex-unreachable` is `critical` for `authentication`, `authorization`, `network`, and `timeout`
  media-server error codes, and `warning` for everything else.
- `metadata-provider-outage` and `lidarr-health-check` carry Lidarr's own `wikiUrl` as
  `remediation.docUrl`, unmodified.
- `monitored-artist-no-monitored-albums` is `info` on purpose: Lidarr's stock "Monitor: Future"
  produces exactly this shape, and it is frequently intentional.
- `similar-artist-name` is restricted to groups whose MusicBrainz ids differ, and is labelled a
  candidate, not a verdict.
- `album-monitored-no-files` filters on the **album's** own monitored flag, so an album under an
  unmonitored artist stays in the list. That is deliberate — it is still a real file gap, and
  hiding it would make it vanish from a `--check library-gaps` run — and the remediation prose
  names the caveat and points at `monitoring-drift`.
- `deferred-intents-pending` carries an exact `evidence.pending` count, but `evidence.overdue` and
  `evidence.nearExhaustion` are derived from at most `evidence.detailWindow` (500 today) of the
  oldest pending intents. When `evidence.detailTruncated` is `true` those two are **lower bounds**,
  and the remediation prose says so. Never divide them by `evidence.pending`.
- `plex-library-name-unresolved` reports a `Library "<name>" not found. Available: <titles>` detail
  in `evidence.available`, composed from the library listing the probe already holds — resolving
  the configured name costs no second Plex request.

**Every `remediation.command` is non-mutating** — a read command or a `rfmedia lidarr plan …`
artifact command. Destructive follow-ups (`rfmedia lidarr apply <file>`, `rfmedia lidarr plan
artist-delete`) appear only in `remediation.action` prose, never as a runnable `command`. A test
sweeps every finding from every evaluator and fails if that invariant is broken.

Group-based findings (`duplicate-artist-mbid`, `duplicate-artist-path`, `similar-artist-name`,
`duplicate-album-mbid`) emit **one finding per group**. `subjects` are that group's members, capped
at 10 entries, `affected` is the true member count before capping, and `evidence.groupSize` repeats
it.

## Selection and Request Cost

`--check` narrows the run, and because the registry drives the gather plan, a narrower selection is
strictly cheaper. Lidarr request counts, without `--deep`:

| Selection                     | Lidarr requests | What runs                                              |
| ----------------------------- | --------------- | ------------------------------------------------------ |
| `--check retry-backlog`       | **0**           | One tracking-database read only                        |
| `--check plex-connectivity`   | **0**           | One Plex request only                                  |
| `--check metadata-dependency` | 1               | Health probe                                           |
| `--check duplicate-identity`  | **2**           | Health probe + artist list                             |
| `--check operation-safety`    | 2               | Health probe + artist list                             |
| `--check library-gaps`        | 3               | Health probe + artist list + one wanted/missing sample |
| Default (all checks)          | 3               | Health probe + artist list + one wanted/missing sample |

The health probe runs first whenever _any_ Lidarr read is planned, because it doubles as the
reachability pre-check. The wanted/missing sample is a single `pageSize: 1` request read for
`totalRecords`; the backlog view itself stays `rfmedia lidarr wanted`. The tracking-database read
and the Plex probe are not Lidarr requests and are never scheduled on the Lidarr lane.

The whole Lidarr gather runs inside exactly one `local-only` scheduler task
(`taskId: "lidarr-audit"`), so `execution` metadata is deterministic even for a zero-request run.

## Deep Scan

`--deep` adds the per-artist album scan, which is what `monitoring-drift` needs and what
`library-gaps` and `duplicate-identity` are enriched by. It costs `1 + N` requests: one library-wide
artist listing inside the scan, plus one album request per scanned artist.

`--deep` therefore issues the artist listing **twice** — once for the audit's own library-wide
`artists` slot, once inside the scan. This is deliberate. The scan narrows its artist list to
`--artist-ids`, while `operation-safety` and `duplicate-identity` must reason over the whole
library; feeding the scan's narrowed data into the `artists` slot would fabricate clean verdicts.
One extra request buys a correct report.

`--artist-ids` is rejected without `--deep`, because there is nothing else for it to scope.

**The deep scan is fail-closed.** If any batched artist read fails or is skipped — including
`budget-exhausted` past the `local-only` lane's operation budget — the whole command fails with exit
code 1 rather than producing a partial `albums` slot. A partial album set fabricates
duplicate-identity groups and gap findings, and a wrong audit is worse than a failed one.

Two escape hatches exist when a full-library deep scan is too large, and the failure message names
both:

1. **Scope the scan** with `--artist-ids`:

   ```bash
   rfmedia lidarr audit --deep --artist-ids 12,34,56
   ```

2. **Raise the lane budget** with the `lidarr.scheduler.lanes.local-only.operationBudget` config
   override (`.rfmedia.yaml`):

   ```yaml
   lidarr:
     scheduler:
       lanes:
         local-only:
           operationBudget: 5000
   ```

An unknown `--artist-ids` value is a different failure: it is rejected before any album batch runs,
so it deliberately carries neither hint.

## Reserved plex-alignment Slot

`plex-alignment` is registered, documented, and present in every report — and it always reports
`status: "skipped"`. It never dispatches an evaluator; the evaluator map is keyed on the non-reserved
ids, so no unreachable function body exists.

Plex artist identity and the shared reconciliation engine now exist, but audit deliberately does
not gather or project that evidence independently. Use
[`rfmedia lidarr reconcile`](plex-lidarr-reconciliation.md) for complete bidirectional alignment,
including exact MBID matches, review-only name evidence, and directional gaps. Keeping the audit
slot reserved avoids a second matcher and preserves the audit's existing request budget.

The legacy skip code remains `identity-mapping-unavailable` for machine compatibility, or
`plex-not-configured` when no Plex credentials exist. Its detail directs operators to
`rfmedia lidarr reconcile`; it no longer claims that the join key or #207/#208 implementation is
absent.

Because the id, the JSON shape, the CSV columns, and the shell completions already carry the slot,
future audit activation can reuse the shared report contract. It must not add an independent title
matcher or derive reverse gaps from incomplete evidence. CI consumers can assert on the slot's
presence and skipped status today.

In its place, `plex-connectivity` ships real media-server signal: one library listing behind an
explicit readiness gate. A configured `plex.libraryName` is resolved against that listing rather
than through a second request. No matching, no identity model.

## Options

| Option                   | Group         | Default | Description                                         |
| ------------------------ | ------------- | ------- | --------------------------------------------------- |
| `--check <ids>`          | `Selection:`  | all 8   | Run only these checks (repeatable, comma-separated) |
| `--deep`                 | `Selection:`  | Off     | Include per-artist album scan (1 + N requests)      |
| `--artist-ids <ids>`     | `Selection:`  | —       | Restrict the deep album scan to these artist IDs    |
| `--fail-on <level>`      | `Safety:`     | `none`  | Exit 1 when findings reach this severity            |
| `-v, --verbose`          | `Output:`     | Off     | Show every finding subject in human output          |
| `--lidarr-url <url>`     | `Connection:` | Config  | Lidarr server URL                                   |
| `--lidarr-api-key <key>` | `Connection:` | Config  | Lidarr API key                                      |
| `--plex-url <url>`       | `Connection:` | Config  | Plex server URL                                     |
| `--plex-token <token>`   | `Connection:` | Config  | Plex API token                                      |

`--check` accepts both forms and combines them: `--check a,b` and `--check a --check b` produce the
same selection, deduplicated and re-ordered into registry order. Two values are rejected locally —
before any client, database, or adapter is constructed — and exit 1 through the standard failure
envelope:

- An id that is not in the registry (see [Check Catalog](#check-catalog) for the valid ids); the
  failure names the offending value.
- A value that carries no id at all: `--check ""`, `--check ","`, `--check " "`. Selecting nothing
  is never what an operator meant, and it is exactly what an unset CI variable expands to, so a
  blank selection fails loudly instead of auditing nothing and passing the `--fail-on` gate.

`--plex-url` without `--plex-token` is refused when it changes origin, so the configured token is
never sent to a host the operator did not authenticate against.

Deliberately absent options:

- **`--severity`** — a display floor that mutates counts and `status` would let a check report `pass`
  while drift exists, on a command built for CI assertion. `jq` covers humans; `--fail-on` covers CI.
- **`--allow-stale`** — no audit cache category exists, and an audit served from cache is actively
  misleading.
- **`--plex-library`** — resolved from `plex.libraryName` in config.
- **Scheduler-tuning flags** — lane concurrency, operation budget, and retry backoff are config-only.

## Human Output

Text output goes to stderr, in this order:

1. Header: `Lidarr Library Audit`, then `Origin · Depth · checkedAt` and a coverage line.
2. Checks table (`Check | Status | Findings | Note`), listing every registered check — rendered on
   every run except the quiet-when-clean path below.
3. Findings table (`Severity | Check | Affected | Summary`), sorted critical → warning → info then by
   registry order, truncated to 20 rows unless `-v` is passed.
4. `Suggested follow-up` — deduplicated by remediation command **and** action prose, capped at 10
   with an `… and N more` line beyond that; each entry prints its command, and its doc URL when the
   finding carries one.
5. One yellow `Degraded:` line per `data-unavailable` or `check-error` check.
6. `Audit gate: PASSED|FAILED (--fail-on <level>; highest severity <x>)`, only when `--fail-on` is set.
7. The execution-lane summary.

Deduplication keys on the command _and_ the action because many codes share one read command —
`rfmedia lidarr health` backs seven of the twenty-three — while the action prose is what carries the
distinct advice, so keying on the command alone would silently drop it.

**Quiet when clean.** A report with no findings whose only skips are the operator's own `--check`
narrowing (`not-selected`) and the reserved `plex-alignment` slot (`identity-mapping-unavailable`)
prints just the header, one green `No findings across N check(s).` line, and the execution summary.
Every other skip reason is a coverage gap — something the operator asked for and did not get — so
it renders the full checks table instead. `--check retry-backlog` on a healthy queue is the
shortest quiet run; a default run reaches it only with `--deep`, since the album checks otherwise
skip as `requires-deep` and the output says so.

## Machine Output

### JSON

JSON and YAML use the standard envelope with a nested result:

```text
{
  "command": "lidarr-audit",
  "result": {
    "execution": {
      "taskId": "lidarr-audit",
      "operation": "lidarr audit",
      "lane": "local-only",
      "outcome": "succeeded",
      "attempts": 1
    },
    "report": {
      "checkedAt": "2026-07-25T18:04:11.220Z",
      "origin": "http://lidarr:8686",
      "deep": false,
      "status": "findings",
      "summary": {
        "critical": 1,
        "warning": 3,
        "info": 2,
        "total": 6,
        "checksRun": 5,
        "checksSkipped": 3,
        "highestSeverity": "critical"
      },
      "checks": [
        {
          "id": "metadata-dependency",
          "title": "Metadata dependency health",
          "status": "findings",
          "findingCount": 1,
          "highestSeverity": "critical"
        },
        {
          "id": "monitoring-drift",
          "title": "Monitoring drift",
          "status": "skipped",
          "findingCount": 0,
          "skipReason": "requires-deep",
          "detail": "the per-artist album scan runs only with --deep (1 + N Lidarr round-trips)"
        },
        {
          "id": "plex-alignment",
          "title": "Plex-Lidarr alignment",
          "status": "skipped",
          "findingCount": 0,
          "skipReason": "identity-mapping-unavailable"
        }
      ],
      "findings": [
        {
          "checkId": "duplicate-identity",
          "code": "duplicate-artist-mbid",
          "severity": "critical",
          "summary": "2 artists share MusicBrainz id f22942a1-...",
          "subjects": [
            { "kind": "artist", "artistId": 42, "name": "Aphex Twin" },
            { "kind": "artist", "artistId": 907, "name": "Aphex Twin" }
          ],
          "affected": 2,
          "evidence": { "foreignArtistId": "f22942a1-...", "groupSize": 2 },
          "remediation": {
            "action": "Two Lidarr entries claim the same MusicBrainz artist. Decide which is canonical, then plan a delete for the other and review the artifact before applying.",
            "command": "rfmedia lidarr lookup artist \"lidarr:f22942a1-...\""
          }
        }
      ],
      "coverage": {
        "artistsExamined": 812,
        "albumsExamined": 0,
        "artistsScanned": 0,
        "wantedTotal": 137
      }
    }
  }
}
```

`report.checks` always contains one entry per registered check, in registry order, whatever the
selection was — so a `--json` consumer can key on ids without probing for their presence.
`coverage.wantedTotal` is `null` when the backlog was not sampled. `report.origin` is credential-free
and never contains the API key.

### CSV

CSV shares one flat file across three row shapes, discriminated by `rowType`, always in this order:

| `rowType` | Count           | Populated column families                                                            |
| --------- | --------------- | ------------------------------------------------------------------------------------ |
| `summary` | exactly 1       | `report.*`, `summary.*`, `coverage.*`, `execution.*`                                 |
| `check`   | one per check   | `check.id`, `check.status`, `check.findingCount`, `check.skipReason`, `check.detail` |
| `finding` | one per finding | `finding.*` including `finding.subjects` and `finding.evidence`                      |

`finding.subjects` and `finding.evidence` are JSON-encoded single cells; every other value is a
scalar. The summary row is always present, including for a clean report with no findings.

## Exit Codes and CI

| Situation                                                                                 | `process.exitCode` |
| ----------------------------------------------------------------------------------------- | ------------------ |
| Success, `--fail-on none` (default) — even with critical findings                         | untouched (0)      |
| Success, findings reach the `--fail-on` level                                             | `1`                |
| Success, `report.status === "degraded"` and `--fail-on` is not `none`                     | `1`                |
| Success, findings below the gate and not degraded                                         | untouched (0)      |
| Pre-flight validation error (unknown or empty `--check`, `--artist-ids` without `--deep`) | `1`                |
| Lidarr client unresolvable, non-transport read failure, partial deep scan                 | `1`                |

The gate is applied **after** the report is rendered, so an operator always sees the evidence behind
a failing CI run. `process.exit()` is never called.

**A `--fail-on` level above a selection's `maxSeverity` is still a live gate.** `--check
monitoring-drift --fail-on critical` cannot produce a critical _finding_, but it still exits 1 if
the report comes back `degraded` — for example because the artist list could not be read, or because
an evaluator threw. A degraded report means a selected check could not be evaluated, and an
incomplete audit must never read green in CI.

The CI-facing scalar is `summary.highestSeverity`. Exit code 1 is this repo's only failure code, so
that field is how "gate tripped" is distinguished from "Lidarr down" (the latter produces no result
at all, only a failure envelope):

```bash
rfmedia lidarr audit --output json --fail-on warning | jq -r '.result.report.summary.highestSeverity'
```

## Skip Reasons and Report Status

Every registered check appears in `report.checks` exactly once. When it produced no verdict, it
carries a machine-readable `skipReason`:

| `skipReason`                   | Meaning                                                       | Degrades? |
| ------------------------------ | ------------------------------------------------------------- | --------- |
| `not-selected`                 | Excluded by `--check`                                         | No        |
| `not-requested`                | No selected check needed the data, so it was not gathered     | No        |
| `requires-deep`                | Album data needs `--deep`                                     | No        |
| `plex-not-configured`          | No Plex URL, or no credential source at all                   | No        |
| `identity-mapping-unavailable` | Reserved slot; use `rfmedia lidarr reconcile` for alignment   | No        |
| `data-unavailable`             | A required source could not be read                           | **Yes**   |
| `check-error`                  | The evaluator threw; isolated so every other check still runs | **Yes**   |

`report.status` precedence is strict: `degraded` (any `data-unavailable` or `check-error`) outranks
`findings`, which outranks `clean`. An expected absence never degrades.

Resilience specifics worth knowing:

- **Lidarr unreachable.** The health probe surfaces transport failure as `status: "unreachable"`
  instead of throwing. The `health` slot stays available with that report — it is the evidence
  `metadata-dependency` needs for its `lidarr-unreachable` critical finding — while `artists`,
  `wanted`, and `albums` become `data-unavailable` and no further Lidarr read is issued.
  `retry-backlog` still produces a full verdict from the tracking database, and `plex-connectivity`
  still runs.
- **A read that fails after a healthy probe.** A transport failure on the `artists` or `wanted`
  read — a timeout on a large library is the realistic case — degrades only that slot. It becomes
  `data-unavailable` with a detail naming the failed read rather than the probe, the checks that
  needed it skip, and every other verdict in the report still renders. Only transport failures
  degrade; any other Lidarr failure class still fails the command with exit code 1.
- **Tracking database unreadable.** The queue collector never throws. Circuit rows degrade per scope
  to an unknown state surfaced verbatim as an `info` finding. If only the per-row detail read fails,
  the status counts remain valid and `queue-detail-unavailable` explains what was lost; the `queue`
  slot stays available and the report is not degraded.
- **Plex.** The probe never throws. Missing credentials yield `plex-not-configured` with no adapter
  constructed at all; a media-server failure becomes a `plex-connectivity` finding discriminated on
  its error code, not on message text. A refused connection override lands here too: a `--plex-url`
  that changes origin without an accompanying `--plex-token` is rejected before any request, and is
  reported as a `plex-unreachable` finding with `evidence.code: "configuration"`. The configured
  token is never sent to the overridden host, and the audit still completes.
- **Plex readiness recognizes enrollment.** A credential source is a static token (`--plex-token` or
  `plex.token`) **or** an enrollment store on disk (`rfmedia plex auth login`). An install that
  dropped `plex.token` after enrolling is fully configured, so a token-only gate would report
  `plex-not-configured` for a working server. The store probe is deliberately coarse — it asks only
  whether a store exists, never whether it is valid for this origin. The narrower question belongs
  to the adapter resolver, and its refusals (not enrolled, an unauthorized origin, or a `jwt`/`token`
  conflict) surface as a `plex-connectivity` finding with `reachable: false`, which is actionable,
  rather than as a silent skip. The `plex-not-configured` detail names `rfmedia plex auth login`
  alongside `plex.token`.

## Deliberately Rejected Checks

These were designed, evaluated, and rejected on the evidence. They remain out of the shared
reconciliation and any future audit activation:

| Rejected check                                            | Why                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plex `albumCount` vs Lidarr `statistics.albumCount` drift | Plex's `albumCount` comes from `childCount` — albums Plex has _scanned_ — while Lidarr counts every tracked album including unreleased and unmonitored ones. Guaranteed constant false positives.                                               |
| Percent-of-tracks coverage thresholds                     | `trackCount` counts tracks across **monitored** albums while `trackFileCount` counts files on disk across **all** albums. The ratio mixes scopes and can exceed 100%. Only the unambiguous `trackCount > 0 && trackFileCount === 0` case ships. |
| "Unmonitored artist with files on disk"                   | Unmonitoring a completed discography is the most common deliberate operator action in Lidarr; this would fire on most of a mature library.                                                                                                      |
| `anyReleaseOk === false` release-policy drift             | Targeting a specific release is a legitimate setting that does not block acquisition.                                                                                                                                                           |
| Metadata-cache freshness                                  | The cache reader throws on a malformed row, the opposite of the resilience snapshot's contract. Isolating it costs more than the signal is worth.                                                                                               |

Deferred for cost rather than correctness — each needs a new client method, domain type, guard,
projector, and codegen contract change: cutoff-unmet backlog, real root-folder and disk-space
figures (Lidarr's own health checks already cover the same ground with a `wikiUrl`), and
download-queue, history, or track-file drift.

## No Mutation or Caching

`lidarr audit` issues read requests only, runs entirely on the `local-only` execution lane, and never
contacts `api.lidarr.audio`. Monitoring edits, profile assignments, and deletion live in the sealed
plan/apply workflow — see [Lidarr Mutation Plan/Apply](lidarr-plan-apply.md). Failures use the
existing Lidarr typed error taxonomy and exit code 1, with the API key and the Plex token redacted
from every diagnostic.

For implementation details, see [Lidarr Execution Lanes](lidarr-execution-lanes.md),
[Lidarr Albums](lidarr-albums.md), and [Lidarr Generated Client](lidarr-generated-client.md).
