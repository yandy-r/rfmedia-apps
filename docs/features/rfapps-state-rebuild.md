# rfapps State Rebuild

The rfapps state database is the only record of what rfapps has deployed. It backs `rfapps history`,
`rfapps rollback --to-generation N`, `rfapps update`, and `rfapps reconcile`, and nothing else in the
platform stores that information. `rfapps state rebuild` reconstructs that database from Docker
runtime and Compose declarations; `rfapps state export` writes a consistent backup copy of it. This
page is the recovery runbook for a corrupt, missing, or incomplete state database.

`rfapps state rebuild` is not `rfapps rebuild`. `rfapps rebuild` recreates containers.
`rfapps state rebuild` only touches the rfapps state database: it never mutates Docker and never
modifies `compose.yml`.

## Symptoms — When to Use This

Use this runbook when any of the following is true:

- `rfapps history` (or `rollback`, `update`, `reconcile`) fails with `SQLITE_NOTADB` or another
  SQLite error that points at the database file itself.
- `state.db` is missing entirely — the host was reinstalled, the home directory was restored from a
  partial backup, or the file was deleted.
- The stored schema version is newer than the installed CLI understands, so the database cannot be
  opened by this version.
- Services that are demonstrably deployed have vanished from `rfapps history`, so the database is
  readable but incomplete.

Do not use this runbook when a single service is missing from history and everything else is fine.
That is the additive, per-service case:

```bash
rfapps import --adopt -s <service>
```

`rfapps state rebuild` is a whole-database operation. It has no `-s/--service`, `--services`,
`-g/--group`, or `--no-sidecars`, because scoping a whole-file replacement would silently produce a
database containing only the scoped services.

## State Database Location

The default database is `~/.config/rfapps/state.db` (XDG). `~/.config/rfapps/` wins whenever it
exists; `~/.rfapps/state.db` is used only when the legacy `~/.rfapps/` directory exists **and** the
XDG directory does not. A fresh install with neither directory present gets the XDG path. The path is
overridable by the
`RFAPPS_STATE_DB_PATH` environment variable or by `state.dbPath` in the rfapps config file.

Most other rfapps commands — `deploy`, `rebuild`, `history`, `rollback`, `prune`, `delete`,
`generations`, and `import` — currently open the default path and ignore both overrides.
`rfapps state rebuild` and `rfapps state export` honour the override and resolve the target file
exactly once, so it is impossible to back up one file and rewrite another. The rebuild report prints
a loud warning when the resolved path is not the default:

```text
Resolved state database <resolved> differs from the default <default>;
other rfapps commands read the default path.
```

If you see that warning, your other rfapps commands are reading a different file than the one being
rebuilt. Resolve that split before trusting a verification step.

## Recovery Sequence

Run every step from the directory containing `compose.yml`, or pass `-f, --compose <path>`.

### Step 1 — Diagnose

```bash
rfapps state rebuild
```

A bare invocation is report-first: it opens the existing database read-only, observes Docker and
Compose, prints the database that would be built, writes nothing, takes no state lock, and exits `0`.
It never opens the existing database read-write, so it is safe on a file that is already corrupt.

The report prints:

- the resolved database path and whether it is the default path;
- database status — `missing`, `readable`, or `unreadable` with a sanitized reason;
- the stored schema version and the `PRAGMA integrity_check` result, when readable;
- deployment and generation row counts, and the tracked service list;
- a disposition for every declared, observed, or tracked service;
- the history that would be dropped.

Add `--show-unchanged` to include `carried`, `absent`, and `orphaned` services in the report.

### Step 2 — Back Up

```bash
rfapps state export
rfapps state export -o /srv/backups/state-before-rebuild.db
```

`state export` uses SQLite's online backup API, so the copy is consistent even while another rfapps
mutation is writing. It never modifies the source and never acquires the state lock, so a
precautionary backup is never blocked by a stuck lock. Note the destination path it prints. Global
`--dry-run` reports the destination and writes nothing.

A source SQLite cannot parse is still exported: the run falls back to a raw byte copy (plus any
`-wal` / `-shm` siblings), reports `method: "raw-copy"`, and exits `0`. That artifact preserves the
damaged file for forensics but may not open as a database, so it is not a guaranteed restore point.

A pre-rewrite backup is also written automatically in step 3 and cannot be disabled; this explicit
export is the copy you control the location of.

### Step 3 — Rewrite

```bash
rfapps state rebuild --rewrite
rfapps state rebuild --rewrite --yes
```

Only `--rewrite` authorizes replacement. Global `--yes` skips the interactive confirmation and never
grants write authority on its own. Global `--dry-run` vetoes the rewrite even when `--rewrite` is
present. Machine-format output additionally requires `--yes` for a rewrite.

The order is strict: probe → mandatory backup → build a complete replacement at a sibling temp path →
swap it into place with `rename()`. The existing database is never mutated, so any failure before the
swap leaves the original file byte-for-byte untouched. If the backup cannot be written, nothing is
rewritten.

### Step 4 — Verify

```bash
rfapps history --limit 20
rfapps history -s <service> --action import
rfapps status --all
```

Reconstructed rows are recorded with action `import`, so `--action import` lists exactly the
baselines the rebuild wrote. `rfapps status --all` confirms the rebuilt database agrees with the
containers actually running.

## Mode: `salvage` vs `runtime-only`

| Mode                | Existing rows                                           | Generation numbers                           | Extra authorization                         |
| ------------------- | ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `salvage` (default) | Every readable deployment and generation row is carried | Preserved verbatim, including deployment ids | `--rewrite`                                 |
| `runtime-only`      | Every existing row is discarded                         | Every service restarts at generation `#1`    | `--rewrite` plus `--confirm-project <name>` |

`salvage` is the default and the right answer almost always. It carries every readable deployment and
generation row into the replacement, preserving `deployments.id` and `generations.generation` — the
identifiers `rfapps rollback --to-deployment <id>` and `rfapps rollback --to-generation N` resolve, and
the ones operators write down — then adds a baseline only for services that have no carried history.
Because a missing or unreadable source has nothing to carry, salvage degenerates into runtime-only
automatically. That makes one mode correct for "the file is gone", "the file is damaged", and "the
file is fine but incomplete" alike.

```bash
rfapps state rebuild --mode salvage --rewrite
rfapps state rebuild --mode runtime-only --rewrite --confirm-project rfmedia-apps
```

`runtime-only` discards history that Docker cannot re-derive, so it is gated harder: it requires
`--confirm-project <name>` matching the Compose project name resolved from your compose file, in
addition to `--rewrite`. `--yes` does not defeat that gate. Use it only when you specifically want a
clean slate — for example, after moving the stack to a new host where the old history is meaningless.

Two more flags affect what is reconstructed:

- `--running-only` restricts reconstruction to services whose container is currently running.
  Discovery otherwise uses `docker compose ps --all`, which also sees created-but-exited containers.
- `--backup-dir <path>` relocates the mandatory pre-rewrite backup.

## Backups and Restore

Unless `--backup-dir` (rebuild) or `-o, --out` (export) says otherwise, artifacts land beside the
database:

```text
~/.config/rfapps/
├── state.db                                   # mode 600
└── backups/                                   # mode 700
    ├── state-2026-07-24T18-15-00-000Z.db      # mode 600
    └── state-2026-07-24T19-02-11-421Z.db      # mode 600
```

The filename is `state-<ISO timestamp>.db` with `:` and `.` replaced by `-`. The parent directory is
created mode 700 and every artifact is written mode 600. An existing destination is never
overwritten — the run fails instead of clobbering an earlier backup.

The artifact is a real SQLite database file, not a dump, so restore is a single `cp` an operator can
perform with a broken CLI:

```bash
rfapps force-unlock                                    # only if a lock is stuck
cp ~/.config/rfapps/backups/state-2026-07-24T18-15-00-000Z.db ~/.config/rfapps/state.db
```

Treat backups as sensitive. They contain full deployment topology and config snapshots. Secret-like
environment values are masked before they are ever persisted, but image identity, volume paths, and
label sets are not.

## Stale Lock Prerequisite

Report-phase `rfapps state rebuild` and `rfapps state export` never acquire the state lock. Only
`rfapps state rebuild --rewrite` does, as operation `state-rebuild`, held for the whole
backup-build-swap sequence so no concurrent rfapps mutation can write underneath it.

If a stuck lock blocks the rewrite, inspect and clear it:

```bash
rfapps force-unlock
```

Verify first that no other rfapps CLI invocation or MCP mutation is still running. `force-unlock`
removes the lock unconditionally; clearing a live lock lets two mutations run against the same
database.

## What Rebuild Can and Cannot Recover

### Recoverable

- Image identity for every observed, inspectable container: `image_tag` (the configured image),
  `image_id` (the local image id), and `image_digest` (the repository digest).
- Config snapshots built from container inspect data: image, environment (masked), volumes, ports,
  networks, and labels.
- Services whose containers are created-but-exited, because discovery uses `docker compose ps --all`.
  `rfapps import` uses `ps --status running` and cannot see them — which matters most after a host
  failure, when most of the stack is exited but still holds recoverable image identity.
- In `salvage` mode, every readable deployment row, generation row, deployment id, and generation
  number from the existing database, including rows the runtime can no longer explain.

### Not recoverable

- Failed deployments (`status: "failed"`). Docker keeps no record of a deploy that failed. They are
  carried in salvage; they are never reconstructed.
- `plan_id` linkage to saved plans. It exists only in the state database. Carried in salvage, never
  reconstructed.
- Original deployment timestamps for reconstructed baselines. A container's `StartedAt` is a restart
  time, not a deploy time; recording it would corrupt `rfapps history --since` and
  generation-at-time lookups. The rebuild timestamp is recorded instead.
- Pre-rebuild generation numbers under `--mode runtime-only`. Every service restarts at `#1`. This is
  why the mode needs `--confirm-project`, and why the backup restores them with one `cp`.
- History for services with no container and no readable source rows. Nothing observable exists;
  they are listed in `summary.droppedServices`.
- Unmasked environment values. `maskSensitiveEnvVars` runs before persistence, by design.

Nothing read out of `compose.yml` is ever persisted. Compose supplies the enumeration of services;
the container supplies every recorded value. A compose file edited after deployment therefore cannot
poison a recovered baseline, which is what keeps `rfapps drift detect` honest afterwards.

## Dispositions

Every service in the report carries exactly one disposition:

| Disposition     | Meaning                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| `reconstructed` | A baseline row was (or would be) written from observed runtime                              |
| `carried`       | Readable history exists and its latest generation matches runtime                           |
| `stale`         | Readable history exists but its latest generation image id differs from runtime, or is null |
| `orphaned`      | Has state rows but is neither declared in compose nor observed                              |
| `absent`        | Declared in compose but no container was observed                                           |
| `uninspectable` | Observed, but inspection failed — zero rows are written for it                              |

`carried`, `absent`, and `orphaned` are hidden unless `--show-unchanged` is passed. `orphaned`
services are carried in salvage and dropped in runtime-only. `uninspectable` services get zero rows
on purpose, so they stay reconstructible on a later retry.

`stale` is reported and never rewritten. Appending a fresh baseline for a drifted service would
record un-reconciled drift as that service's newest generation, so a `rollback` to latest would
restore the drift. Fix the drift instead:

```bash
rfapps reconcile -s <service>
rfapps deploy -s <service> --yes
```

On a pre-v3 database, services can be classified `stale` simply because no image id was ever
recorded — the v3 migration deliberately does not backfill `image_id`. The report distinguishes
that case ("no recorded image identity — pre-v3 row") from a genuine mismatch ("recorded image id
differs from runtime") in each service's reason text. If a legacy rebuild reports the whole stack as
stale, read the reason before reaching for `rfapps reconcile`.

## The `state-rebuild.v1` JSON Contract

```bash
rfapps state rebuild --json
rfapps state rebuild --rewrite --yes --json
```

Machine formats emit the whole result envelope to stdout; human text always goes to stderr. A
machine-format rewrite additionally requires global `--yes`.

| Field           | Notes                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| `schemaVersion` | Always `"state-rebuild.v1"`                                                      |
| `operation`     | Always `"state-rebuild"`                                                         |
| `phase`         | `"report"` or `"rewrite"`                                                        |
| `mode`          | `"salvage"` or `"runtime-only"`                                                  |
| `project`       | Resolved Compose project name                                                    |
| `composePath`   | Resolved, symlink-free compose file path                                         |
| `database`      | The read-only probe: `path`, `status`, `isDefaultPath`, counts, tracked services |
| `backup`        | Present only when the database was actually replaced                             |
| `carryOver`     | Present only for `rewrite`: carried, discarded, and re-derived row counts        |
| `services`      | One entry per service, with its disposition and image identity                   |
| `summary`       | Aggregate counts, `droppedServices`, and the discarded-row invariants            |
| `refusal`       | Present only when an authorized rewrite was refused                              |
| `success`       | Boolean                                                                          |
| `exitCode`      | `0`, `1`, `2`, or `3`                                                            |

The machine-checkable safety invariant after a clean salvage — **note the `mode` assertion, it is
load-bearing**:

```bash
rfapps state rebuild --rewrite --yes --json |
  jq -e '.mode == "salvage"
         and .summary.discardedDeployments == 0
         and .summary.discardedGenerations == 0'
```

`summary.discardedDeployments` and `summary.discardedGenerations` count rows that carry-over could
not salvage. Carry-over runs **only in `salvage` mode**, so under `--mode runtime-only` both counters
are always `0` — not because nothing was discarded, but because runtime-only discards all history by
design and never attempts a carry-over to count failures against. **The counters are meaningless
under `runtime-only`.** A CI guard that omits `.mode == "salvage"` will therefore certify a
runtime-only wipe as non-destructive. Always assert the mode as well.

`database.path` and `database.isDefaultPath` are always present, so automation can prove which file
was touched.

An authorized rewrite whose planned replacement would contain zero deployment rows is refused before
any side effect: nothing is backed up, nothing is built, `refusal.reason` is `"empty-plan"`, and the
exit code is `2`. That refusal is emitted as a result, not as an exception, so a CI job can read it
out of the envelope. Neither "the Docker daemon is down" nor "everything is stopped" is ever reported
as a successful rebuild.

`rfapps state export` emits the same-shaped `state-export.v1` envelope with `database`,
`destination`, `backup`, `dryRun`, `success`, and `exitCode`.

## Boundary vs `import` and `drift import`

| Aspect                         | `rfapps import --adopt`                  | `rfapps state rebuild --rewrite`                              | `rfapps drift import`            |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------------------- | -------------------------------- |
| Unit of work                   | one service at a time                    | the whole database file                                       | `compose.yml`                    |
| Touches state DB               | appends rows in place                    | replaces the file atomically                                  | never                            |
| Touches `compose.yml`          | never                                    | never                                                         | rewrites it                      |
| Services with existing history | skipped (`getDeploymentCount > 0`)       | carried verbatim (salvage) or dropped (runtime-only)          | n/a                              |
| Works on a corrupt DB          | no — `initializeDatabase()` throws first | yes — this is its purpose                                     | n/a                              |
| Container discovery            | `ps --status running`                    | `ps --all` (created and running)                              | `ps`                             |
| Backup                         | none                                     | mandatory, non-disableable                                    | optional `.bak` of `compose.yml` |
| Generation numbers             | appends `#1` to untracked services       | preserved verbatim (salvage) / restart at `#1` (runtime-only) | n/a                              |
| Authorization                  | `--adopt`                                | `--rewrite` (plus `--confirm-project` for runtime-only)       | `--yes`                          |
| Lock operation                 | `import`                                 | `state-rebuild`                                               | `drift-import`                   |
| Cadence                        | routine, additive, idempotent            | rare, operator-driven recovery                                | occasional                       |

Which do I use?

- "A service I started with `docker compose up` is missing from `rfapps history`." →
  `rfapps import --adopt -s <svc>`.
- "`rfapps history` errors with `SQLITE_NOTADB`, or `state.db` is gone, or half my services vanished
  from it." → `rfapps state rebuild` (report), then `--rewrite`.
- "I want a copy of `state.db` before doing something risky." → `rfapps state export`.
- "`compose.yml` no longer matches my running containers and I want compose updated." →
  `rfapps drift import`.

Neither command is a superset of the other. `import` cannot repair: it skips services that already
have history and cannot open a damaged file. `state rebuild` is not the everyday tool: it is a
whole-file operation.

See [rfapps Drift Command](rfapps-drift-command.md) and
[rfapps Reconcile Command](rfapps-reconcile-command.md) for the compose-side workflows, and
[Deployment History](deployment-history.md) for what the state database records.

## Exit Codes

`rfapps state rebuild`:

| Code | Meaning                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Report completed, or the database was rewritten with nothing discarded                                                       |
| `1`  | Observation, backup, build, or swap failed — the database is unchanged in every case                                         |
| `2`  | Invalid or unsafe usage, cancelled, or the rewrite was refused because the plan would be empty                               |
| `3`  | Partial: the database was rewritten but a container could not be inspected, or unreadable rows were discarded during salvage |

`rfapps state export`:

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| `0`  | Backup written, or dry-run reported the destination |
| `1`  | The backup could not be written                     |
| `2`  | Invalid or unsafe usage                             |

An unreadable source is **not** an export failure. When SQLite cannot parse the source, `state export`
falls back to a raw byte copy and still exits `0` with `success: true` and `backup.method` set to
`"raw-copy"`; `database.status` reports `unreadable` and the text output warns that the artifact may
not open as a database. Preserving the bytes of a corrupt file is the point — a recovery command must
not refuse to back up the very file you are recovering. Exit `1` means only that no artifact was
produced at all: the destination already exists, the directory is not writable, or both copy
strategies failed. Automation that needs a restorable artifact must assert
`backup.method == "sqlite-backup"`, not merely `exitCode == 0`.

Exit `3` is deliberately not used when the pre-existing database was `unreadable`. That is the
expected input to a recovery command, not a partial result.
