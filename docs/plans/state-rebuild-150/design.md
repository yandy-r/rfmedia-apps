# Design: rfapps state rebuild (#150)

## Problem & scope

The rfapps state database (`~/.config/rfapps/state.db` by default) is the only record of what rfapps
has deployed. It backs `rfapps history`, `rfapps rollback --to-generation N`, `rfapps update`, and
`rfapps reconcile`. Today there is **no way to recover it**:

- `initializeDatabase()` (`src/lib/db.ts:135-176`) unconditionally opens the file read-write,
  `db.exec()`s `schema.sql`, and calls `runMigrations(db)`. On a corrupt file better-sqlite3 throws
  `SQLITE_NOTADB` before any recovery code can run, so every existing command fails on exactly the
  input that needs repair.
- `rfapps import` writes only where `getDeploymentCount(db, { service }) > 0` is false
  (`src/actions/import.ts:395`). It no-ops on any service that already has a row, so it cannot
  repair a partially damaged database.
- There is **no backup, export, dump, or restore path anywhere in the package**. The only `--backup`
  in the repo is `copyFile` of `compose.yml` in `src/actions/drift.ts:336-341`.

Issue #150 asks for a recovery command that reconstructs state from Docker runtime and compose
declarations, with backup/export before rewrite and a documented corrupted-DB workflow.

**Scope.** A new nested command group `rfapps state` with two subcommands:

- `rfapps state export` — write a consistent, private, restore-with-one-`cp` copy of the state
  database. Read-only, lock-free.
- `rfapps state rebuild` — report-first reconstruction of the **whole database file**. It never
  opens the existing database read-write. It builds a complete replacement at a sibling temp path
  through the sanctioned `initializeDatabase(tempPath)` and `rename()`s it into place, so every
  failure before the swap is indistinguishable from "nothing happened".

The issue's named files (`src/commands/state.ts`, `src/lib/state.ts`) are approximate:
`src/commands/state.ts` does not exist yet (it will), and there is no `src/lib/state.ts` — the state
subsystem is `lib/{db,schema.sql,migrations,state-storage,state-queries,generations,state-lock}.ts`.

**Non-goals.** No container mutation, no `compose.yml` mutation, no MCP tool, no per-service scoping
(see [Explicitly out of scope](#explicitly-out-of-scope)).

## Boundary vs `rfapps import` and `rfapps drift`

|                                    | `rfapps import --adopt`                  | `rfapps state rebuild --rewrite`                            | `rfapps drift import`            |
| ---------------------------------- | ---------------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| Unit of work                       | one service at a time                    | the whole database file                                     | `compose.yml`                    |
| Touches state DB                   | appends rows in place                    | replaces the file atomically                                | never                            |
| Touches `compose.yml`              | never                                    | never                                                       | rewrites it                      |
| Services with existing history     | skipped (`getDeploymentCount > 0`)       | carried verbatim (salvage) or dropped (runtime-only)        | n/a                              |
| Works on a corrupt / unopenable DB | no — `initializeDatabase()` throws first | **yes — this is its purpose**                               | n/a                              |
| Container discovery                | `ps --status running`                    | `ps --all` (created **and** running)                        | `ps`                             |
| Backup                             | none                                     | mandatory, non-disableable                                  | optional `.bak` of `compose.yml` |
| Generation numbers                 | appends #1 to untracked services         | preserved verbatim (salvage) / restart at #1 (runtime-only) | n/a                              |
| Authorization                      | `--adopt`                                | `--rewrite` (+ `--confirm-project` for `runtime-only`)      | `--yes`                          |
| Lock operation                     | `import`                                 | `state-rebuild`                                             | `drift-import`                   |
| Cadence                            | routine, additive, idempotent            | rare, operator-driven recovery                              | occasional                       |

**Which do I use?**

- _"A service I started with `docker compose up` is missing from `rfapps history`."_ → `rfapps import --adopt -s <svc>`.
- _"`rfapps history` errors with `SQLITE_NOTADB`, or `state.db` is gone, or half my services vanished from it."_ → `rfapps state rebuild` (report), then `--rewrite`.
- _"I want a copy of `state.db` before doing something risky."_ → `rfapps state export`.
- _"`compose.yml` no longer matches my running containers and I want compose updated."_ → `rfapps drift import`.

Neither is a superset of the other. `import` cannot repair (it skips tracked services and cannot
open a damaged file); `state rebuild` is not the everyday tool (it is a whole-file operation). The
type-level proof is the disposition union: `state-rebuild.v1` has no `candidate` member and
`import.v1` has no `carried`/`stale`/`orphaned` members.

## Command surface

### Command tree

```
rfapps state                        # group (registerStateCommand)
  rfapps state export [options]     # read-only, lock-free
  rfapps state rebuild [options]    # report-first; --rewrite authorizes
```

Registered exactly like `registerDriftCommand` (`src/commands/drift.ts`) — the only nested-group
precedent — with `registerImportCommand`'s injectable `loadAction()` dependency object and
`.configureHelp({ showGlobalOptions: true })`. Subcommand actions forward the **root**
`program.opts()`, matching drift.

### Group

```
.description("Inspect, export, and reconstruct the rfapps state database")
```

Group `addHelpText("after", ...)`:

```
Read-only commands:
  export   Write a consistent, private copy of the state database.

Mutation commands:
  rebuild  Reconstruct the state database from Docker runtime and compose declarations.
```

### `rfapps state export`

```
.description("Write a consistent backup copy of the rfapps state database")
```

| Flag               | Exact description string    | Default                                    |
| ------------------ | --------------------------- | ------------------------------------------ |
| `-o, --out <path>` | `"Backup destination file"` | `<state-dir>/backups/state-<timestamp>.db` |

`addHelpText("after", ...)`:

```
Uses SQLite's online backup API, so the copy is consistent even while another
rfapps mutation is writing. It never modifies the source database and never
acquires the state lock, so a precautionary backup is never blocked by a stuck
lock. Global --dry-run reports the destination and writes nothing.

The artifact is created mode 600 inside a mode 700 parent. It contains full
deployment topology and config snapshots (secret-like environment values are
masked, but treat the file as sensitive).

Restore is a plain file copy:
  cp <backup> ~/.config/rfapps/state.db

Exit codes:
  0  Backup written, or dry-run reported
  1  Source unreadable or the backup could not be written
  2  Invalid or unsafe usage
```

### `rfapps state rebuild`

```
.description("Reconstruct the state database from Docker runtime and compose declarations")
```

| Flag                       | Exact description string                                                               | Default                                               |
| -------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `--mode <mode>`            | `"Reconstruction mode (salvage keeps every readable row, runtime-only discards them)"` | `"salvage"` (`.choices(["salvage", "runtime-only"])`) |
| `--rewrite`                | `"Replace the state database with the reconstruction"`                                 | `false`                                               |
| `--confirm-project <name>` | `"Compose project name; required by --mode runtime-only"`                              | —                                                     |
| `--running-only`           | `"Only reconstruct services whose container is currently running"`                     | `false`                                               |
| `--backup-dir <path>`      | `"Directory for the mandatory pre-rewrite backup"`                                     | `<state-dir>/backups`                                 |
| `--show-unchanged`         | `"Include carried, absent, and orphaned services in the report"`                       | `false`                                               |
| `-f, --compose <path>`     | `"Path to Docker Compose file"`                                                        | —                                                     |
| `-e, --env-file <path>`    | `"Path to environment file"`                                                           | —                                                     |
| `-p, --profile <name>`     | `"Docker Compose profile to use"`                                                      | —                                                     |

**No `-s/--service`, `--services`, `-g/--group`, or `--no-sidecars`.** Scoping a whole-file
replacement is incoherent: a scoped rebuild would silently produce a database containing only the
scoped services. Per-service work is `rfapps import --adopt -s <svc>`.

`addHelpText("after", ...)`:

```
This is NOT `rfapps rebuild`, which recreates containers. This command only
touches the rfapps state database; it never mutates Docker and never modifies
compose.yml.

Report-first: a bare invocation opens the existing database READ-ONLY, observes
Docker and compose, and prints the database that WOULD be built. It writes
nothing and takes no state lock. Only --rewrite authorizes the replacement.
Global --yes only skips human confirmation; it does not grant write authority.
Global --dry-run vetoes the rewrite even when --rewrite is present. Machine-
format rewrite additionally requires global --yes.

A pre-rewrite backup is mandatory and cannot be disabled. If the backup cannot
be written, nothing is rewritten.

The rebuild NEVER mutates the existing database. It builds a complete
replacement beside it and swaps atomically, so any failure leaves the original
file byte-for-byte untouched.

Modes:
  salvage       (default) Carry every readable deployment and generation row
                from the existing database into the replacement, preserving
                deployment ids and generation numbers, then add baselines only
                for services that have no carried history.
  runtime-only  Discard every existing row; the replacement contains only
                runtime-derived baselines. Because this drops history that
                Docker cannot re-derive, it additionally requires
                --confirm-project <name> matching the resolved Compose project.

This is a whole-database operation and takes no service scope. To adopt one
untracked service without touching the rest, use `rfapps import --adopt`.

Exit codes:
  0  Report completed, or the database was rewritten with nothing discarded
  1  Observation, backup, build, or swap failed (the database is unchanged)
  2  Invalid or unsafe usage, cancelled, or the rewrite was refused
  3  Partial: the database was rewritten but a container could not be inspected
     or unreadable rows were discarded during salvage
```

### Exit codes

| Code | `state rebuild` meaning                                                                                                                                                                                                       | `state export` meaning                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `0`  | Report completed; or rewrite completed with `uninspectable === 0`, `discardedDeployments === 0`, `discardedGenerations === 0`                                                                                                 | Backup written, or dry-run reported         |
| `1`  | `docker compose config` / `ps --all` failed, probe I/O failed, backup failed, replacement build failed, or the swap failed — **the database is unchanged in every case**                                                      | Source unreadable or destination unwritable |
| `2`  | Invalid/unsafe usage (`--confirm-project` missing or mismatched, machine format without `--yes`, `state.enabled === false`), confirmation declined, or the rewrite was refused because the planned replacement would be empty | Invalid/unsafe usage                        |
| `3`  | Rewrite completed, but at least one observed container was uninspectable **or** rows were discarded during salvage                                                                                                            | _(never used)_                              |

Exit `3` is **explicitly not** used when the pre-existing database was `unreadable`. That is the
expected input to a recovery command, not a partial result.

Derived by `resolveStateRebuildExitCode(result)` in `src/lib/exit-codes.ts`, alongside the existing
`resolveReconcileExitCode` / `resolveDeployExitCode` / `resolveLintExitCode`. Applied via
`setExitCode`, never a raw `process.exitCode` assignment.

## Rebuild semantics

### Target file resolution

Resolved **once** with `getStateDbPath(finalConfig)` (`src/lib/config.ts:648-671`:
`RFAPPS_STATE_DB_PATH` > `config.state.dbPath` > `getDefaultDatabasePath()`), matching `doctor`
(`src/lib/doctor/checkers.ts:317`) and `update`. Probe, backup, build and swap all use that one
value, so it is impossible to back up one file and rewrite another.

Because `deploy`, `rebuild`, `history`, `rollback` and `import` all call bare
`initializeDatabase()` and ignore config/env, the result carries `database.isDefaultPath`, and the
text report emits a loud `logWarn` when it is `false`:

```
Resolved state database <resolved> differs from the default <default>;
other rfapps commands read the default path.
```

Surfacing this pre-existing split-brain is in scope; fixing it across nine actions is not.

### Reading the existing database — read-only, always

The source is **only ever** opened `new Database(path, { readonly: true, fileMustExist: true })` —
the in-repo precedent at `src/lib/doctor/checkers.ts:326` and `src/testing/cli-harness.ts:276`.
`initializeDatabase()` is called **exclusively on the temp path**. Consequences:

- A corrupt file can be probed and backed up without `SQLITE_NOTADB` aborting first.
- A v1/v2 database is **not** migrated by a read-only report (which would be a write, taken without
  the state lock).
- `runMigrations`'s plain-`Error` guard for `schema_version > 3` (`src/lib/migrations.ts:104-112`,
  which has no registered formatter) can never fire on this path — the probe reports it instead.

`probeStateDatabase(path)` returns a discriminated result and **never throws**:

- `missing` — no file at the path.
- `unreadable` — open failed, `PRAGMA integrity_check` failed, or `schema_version > 3`; carries a
  sanitized `reason`.
- `readable` — carries `schemaVersion`, `integrity`, `deployments`, `generations`,
  `trackedServices` (`SELECT DISTINCT service FROM deployments ORDER BY service`),
  `oldestTimestamp`, `newestTimestamp`.

Every count query is **individually** `try`/`catch`ed and gated on `sqlite_master`, because a real
v1 database has no `generations` table at all.

### Runtime and compose observation

1. `resolveComposeProjectIdentity(finalConfig.composePath, { envFile, envTool })`
   (`src/lib/identity.ts:168`) yields a realpath'd, symlink-free `composePath`, a `projectDir`, and
   a **validated** `projectName` (`/^[a-z0-9][a-z0-9_-]*$/`). Running from the wrong directory during
   an additive `import` adds a few rows; during a whole-file replacement it would reconstruct the
   wrong project's state. `projectDir` is used as `cwd` for every Docker call.
2. `getComposeConfig(composePath, { profiles, envFile, projectName, envTool, cwd: projectDir })`
   supplies the **declared universe**: `Object.keys(composeConfig.services)`. `undefined` →
   `DockerCommandError("config", ...)` + exit 1.
3. `getComposeContainerObservations(composePath, { profiles, envFile, projectName, envTool, cwd })`
   (`src/lib/docker.ts:1334`, `docker compose ps --all --format json`) supplies the **observed**
   containers, including created-but-exited ones. After a host failure most of the stack is exited
   but still holds recoverable image identity; `import`'s `ps --status running` view cannot see it.
   `--running-only` filters to `state === "running"`. This helper throws `DockerIdentityError` on
   malformed evidence → exit 1.
4. `profiles = [finalConfig.profiles.defaultProfile]` (`applyCliOverrides` sets it from `-p`,
   `src/lib/config.ts:519`). No `resolveServicesWithInteractive` — there is no scope to resolve.

### Per-service capture

`captureRuntimeBaseline(container, { cwd, envTool })` (extracted from `import`'s `captureBaseline`)
calls `inspectContainerIdentity` then `inspectContainers([container])`. **Fail-closed**: any throw or
missing inspect result returns `undefined`, the service becomes `uninspectable`, and **zero rows** are
written for it, so it stays reconstructible on retry.

### What is derived from what

| Column                     | Source                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `service`                  | compose declaration (the universe) / observation `serviceName`                            |
| `image_tag`                | runtime — `identity.configuredImage`                                                      |
| `image_id`                 | runtime — `identity.localImageId`                                                         |
| `image_digest`             | runtime — `identity.repositoryDigest`                                                     |
| `config_snapshot`          | runtime — `buildConfigSnapshotFromInspect(inspect)`, env masked by `maskSensitiveEnvVars` |
| `timestamp`                | one shared `new Date().toISOString()` per batch                                           |
| `action`                   | literal `"import"` (see below)                                                            |
| `status`                   | literal `"success"`                                                                       |
| `plan_id`, `error_message` | always `null` for reconstructed rows                                                      |

Compose supplies the _enumeration_; the container supplies every _value_. Nothing read out of
`compose.yml` is ever persisted — a compose file edited after deployment must not be able to poison
a recovered baseline, or `rfapps drift detect` would report zero drift against a fabricated truth.

**Action value: reuse `"import"`, do not add `"state-rebuild"`.** The row means the same thing (a
baseline observed from a container). A new `DeploymentAction` would require synchronized edits to
`src/types/state.ts:35-43`, `GenerationAction` at `:147`, `GENERATION_ACTIONS` in
`src/lib/state-storage.ts:68-76`, `VALID_ACTIONS` in `src/actions/history.ts:111-119`,
`getActionColor` in `src/lib/formatters/state-display.ts:69-88`, three shell `--action` value lists
(`completion.ts:209`, `:639`, `:1043`) and four `mcp/schema.ts` enums (`:124`, `:481`, `:506`,
`:831`) — a large blast radius for a distinction the `state-rebuild.v1` report and the timestamped
backup filename already carry. _(One-line judge disagreement resolved: forensic provenance lives in
the report envelope, not in a ninth enum value.)_

### Dispositions (evaluated in this exact order)

Computed against the **probe's** `trackedServices` (read-only), never against a writable handle.

1. Service is declared but has no observation → `absent`. Zero reconstructed rows.
2. Service is **not** declared but appears in `probe.trackedServices` and has no observation →
   `orphaned`. Carried in salvage, dropped in runtime-only. Never rewritten.
3. Observation exists but `captureRuntimeBaseline` returned `undefined` → `uninspectable`. Zero rows.
4. Mode is `salvage` **and** the service has carried deployment rows:
   - latest carried generation's `image_id` equals the observed `localImageId` → `carried`.
   - otherwise (including a `NULL` recorded `image_id`, which migration v3 deliberately does not
     backfill) → `stale`. **Reported, never rewritten.** Appending a fresh baseline here would record
     un-reconciled drift as the service's newest generation, so `rollback` to latest would restore
     the drift. Point the operator at `rfapps reconcile` / `rfapps deploy`. This is the one thing
     `rfapps import` provably cannot show them, since it skips anything with history.
5. Otherwise (no carried history, or `runtime-only`) → `reconstructed`. One baseline row appended.

### Salvage carry-over (default mode)

`carryOverState(source, target)` runs inside a single `target.transaction`:

1. Read the source table set from `sqlite_master`. If `deployments` is absent, return all-zero counts.
2. `PRAGMA table_info(deployments)` → build the `SELECT` column list from the **intersection** of
   the current schema and what the source actually has. A v1 source has no `image_id`/`image_digest`;
   a v1 source has no `generations` table at all. Naming those columns unconditionally would throw
   `no such column: image_id` on precisely the legacy databases migrations exist for.
3. `SELECT ... FROM deployments ORDER BY id ASC`. Validate each row: `id` a positive integer,
   `service`/`action`/`status`/`timestamp` non-empty strings. Failures increment
   `deploymentsDiscarded` and are skipped — the transaction is never aborted, because corrupt input
   is the input this command exists for.
4. Normalize timestamps: a value matching `/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/` (the SQL
   `DEFAULT (datetime('now'))` format in `schema.sql`) is rewritten to ISO 8601. Every ordering path
   in the codebase is lexicographic (`ORDER BY timestamp DESC`, `timestamp >= ?`,
   `findGenerationAtTime`), so mixed formats silently mis-sort within a day.
5. Insert into the target **preserving the explicit `id`**. `deployments.id` is user-facing: it is
   printed by `rfapps history`, resolved by `findDeploymentById`, and is a rollback target via
   `RollbackOptions.toDeployment`. Letting `AUTOINCREMENT` renumber would break every id an operator
   wrote down. Explicit ids also advance `sqlite_sequence` correctly.
6. If the source has a `generations` table: `PRAGMA table_info(generations)` → intersection again
   (a v2 table has no `image_id`/`image_digest`). Copy rows `ORDER BY id ASC`, **preserving
   `generation` verbatim** — `rollback --to-generation N` and operator runbooks reference those
   numbers. `deployment_id` is kept when it exists in the carried id set (ids are preserved, so no
   remapping is needed) and set to `NULL` otherwise, keeping the FK valid under
   `pragma foreign_keys = ON`. Rows with a non-integer `generation`, an empty `service`, or a
   duplicate `(service, generation)` — pre-detected with a `Set` — increment
   `generationsDiscarded` and are skipped.
7. **Only if** deployments were carried and zero generations were carried (source predates v2, or
   the generations table was lost), re-derive them in the target with
   `ROW_NUMBER() OVER (PARTITION BY service ORDER BY timestamp ASC, id ASC)` — the shape of the v2
   migration (`src/lib/migrations.ts:145-166`) — but filtered by the **current, exported**
   `GENERATION_ACTIONS` set, not v2's stale literal `('deploy','rebuild','apply','rollback')` which
   omits `update` and `import`. Counted as `generationsDerived`.
8. `metadata` is **not** carried. The replacement keeps the fresh `schema_version` stamped by
   `runMigrations()` — carrying a stale or future version is exactly the corruption being repaired.

A missing or unreadable database degenerates salvage into runtime-only automatically (nothing to
carry), which is why salvage is the safe default: it is correct for "file is gone", "file is
damaged", and "file is fine but incomplete" alike.

### Baseline append

After carry-over, in one `recordDeployments(target, entries)` call (one transaction, one shared ISO
timestamp), for every service classified `reconstructed`, sorted lexicographically.
`recordDeployments` (`src/lib/state-storage.ts:360-400`) inserts the deployment and — because
`"import"` is in `GENERATION_ACTIONS` — calls `createGeneration()` in the same transaction, which
computes `COALESCE(MAX(generation), 0) + 1 WHERE service = ?` (`src/lib/generations.ts:96-127`).

Generation numbers are **never chosen by this feature**. The real assigned number is read back per
written service via `getGenerations(target, { service, limit: 1 })[0].generation` (that query is
`ORDER BY generation DESC` when a service filter is present, `src/lib/generations.ts:154-162`) and
reported. `import.ts:481` hardcodes `generation = 1`, which is only accidentally correct because its
candidates provably had none; a database with orphaned generations but no deployments would make
that a lie. Here a service carrying generations `1..N` legitimately gets `N+1`.

### Ordering, idempotency, conflict rules

- **Ordering.** Services are processed in sorted order; carried rows are inserted in ascending `id`
  order; every written timestamp is explicit ISO 8601.
- **Idempotency (salvage).** Re-running `state rebuild --rewrite` on the output of a previous rebuild
  carries every row (including the baselines the first run wrote) and appends **nothing**, because
  every observed service now has carried history. Row content is identical.
- **Idempotency (runtime-only).** Not history-preserving across runs by definition, but
  content-idempotent: each run yields exactly one baseline per observed, inspectable service.
- **Conflict rules.** The target is provably fresh, so there is no merge: carried rows win by
  construction, and a baseline is appended only where the carried deployment count for that service
  is zero. `UNIQUE(service, generation)` conflicts can only originate in the source and are discarded
  and counted.
- **Refusal.** If `--rewrite` is authorized but the planned replacement would contain **zero**
  deployment rows (nothing carried and nothing reconstructed), the rebuild is **refused**: nothing is
  backed up, nothing is built, `result.refusal = { reason: "empty-plan", ... }`, exit 2. Neither "the
  Docker daemon is down" nor "everything is stopped" may ever be reported as a successful rebuild.

### Atomic swap

`swapStateDatabase(tempPath, targetPath, backupPath)`:

1. `chmod(tempPath, 0o600)`.
2. `rename(tempPath, targetPath)` — same directory, therefore same filesystem, therefore atomic.
3. Unlink `${targetPath}-wal` and `${targetPath}-shm` if present. Those sidecars belong to the file
   that was just replaced; a stale WAL beside a fresh database can be replayed onto it and corrupt
   it. (Nothing in the repo enables WAL today; this is two defensive lines that close a real vector
   if a future version or an external tool ever opens the DB in WAL mode.)

On any failure the temp file is unlinked and the error rethrown. The target is byte-identical to
before. The old contents survive in the mandatory backup.

### Intentionally NOT recoverable, and why

| Not recovered                                                      | Why                                                                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed deployments (`status: "failed"`)                            | Docker keeps no record of a deploy that failed. Carried in salvage; never reconstructed.                                                                                |
| `plan_id` linkage to saved plans                                   | Lives only in the state DB. Carried in salvage; never reconstructed.                                                                                                    |
| Original deployment timestamps for reconstructed baselines         | A container's `StartedAt` is a restart time, not a deploy time. Recording it would corrupt `history --since` and `findGenerationAtTime`. The rebuild timestamp is used. |
| Pre-rebuild generation numbers in `runtime-only`                   | Every service restarts at #1. This is why the mode requires `--confirm-project`, and why the backup restores them with one `cp`.                                        |
| History for services with no container and no readable source rows | Nothing observable exists. Reported in `summary.droppedServices`.                                                                                                       |
| Unmasked environment values                                        | `maskSensitiveEnvVars` runs before persistence, by design.                                                                                                              |

## Safety contract

### Report-first

A bare `rfapps state rebuild`:

- opens the existing database **read-only** and never through `initializeDatabase()`;
- writes no file — not even a backup;
- acquires **no state lock** (so an operator can inspect a rebuild plan while a deploy is in flight);
- prints the probe (path, status, schema version, integrity, row counts, tracked services), every
  service disposition, the history that would be dropped, and exits 0.

### Authorization ladder

All guards run **before** any Docker, probe, or filesystem work, mirroring `import.ts:274-320`.

1. `--rewrite` absent → report phase, unconditionally.
2. Global `--dry-run` + `--rewrite` → `logWarn("--dry-run overrides --rewrite; the state database will not be replaced.")` and degrade to report (exit 0).
3. `finalConfig.state?.enabled === false` + `--rewrite` → `InvalidArgumentError("--rewrite", "true", "State tracking is disabled; enable it to rebuild the state database")` → exit 2.
4. `--mode runtime-only` + `--rewrite` **without** `--confirm-project` → `InvalidArgumentError("--confirm-project", "", "Discarding existing history requires the Compose project name")` → exit 2.
5. `--confirm-project <name>` ≠ the project name from `resolveComposeProjectIdentity` → `InvalidArgumentError("--confirm-project", name, "Does not match the resolved Compose project", [projectName])` → exit 2. Guards 4–5 make an accidental total wipe structurally unreachable: the token cannot be produced by muscle memory, tab completion, or shell-history recall from a different project, and `--yes` does not defeat it. _(Salvage needs only `--rewrite`, because salvage preserves every readable row by construction.)_
6. `isMachineFormat(format) && !yes` + `--rewrite` → `InvalidArgumentError("--yes", "false", "Machine-format rebuild requires explicit --rewrite --yes")` → exit 2.
7. Text + interactive → `confirm(...)`; declining re-renders the report and sets exit 2.

Global `--yes` **never** grants write authority; it only skips step 7.

Confirmation prompt (salvage):

```
Replace <path> with a database rebuilt from Docker?
<D> deployment row(s) and <G> generation(s) will be carried, <N> baseline(s) added,
history for <K> service(s) dropped. A backup will be written to <backupPath>.
```

Confirmation prompt (runtime-only):

```
DISCARD <D> deployment row(s) and <G> generation(s) at <path> and rebuild <N>
baseline(s) from Docker? History for <K> service(s) will be dropped and every
service restarts at generation #1. A backup will be written to <backupPath>.
```

### Backup — mandatory, non-disableable

There is **no** `--no-backup` and no `--force-without-backup`. A flag that skips the safety net is
exactly the "fallback that hides the real issue" the repo forbids, and it would be used once, at the
worst possible moment.

Strict order: **probe → backup → build replacement → confirm nothing failed → swap.** If the backup
throws, the action emits the error, sets exit 1, and returns before a temp database is even created.

- **Format**: a real SQLite database file, not a dump. Restore must be a single `cp` an operator can
  perform with a broken CLI.
- **Primary method** (`method: "sqlite-backup"`): `new Database(src, { readonly: true, fileMustExist: true }).backup(dest)` — verified present in `@types/better-sqlite3` as `backup(destinationFile: string, options?): Promise<BackupMetadata>`, with `better-sqlite3` at 12.6.2. This is the online backup API: consistent under a concurrent writer and journal-safe. A plain `copyFile` of a live SQLite database is not, which is why `drift import --backup`'s `copyFile` precedent is deliberately **not** copied here.
- **Fallback** (`method: "raw-copy"`): if the read-only open or `.backup()` throws (`SQLITE_NOTADB` etc.), `copyFile()` the raw bytes plus any `-wal`/`-shm` siblings. The disaster path must not depend on the happy path working; forensic bytes are preserved even when SQLite cannot parse the file. If that also fails → exit 1, nothing else runs.
- **Path**: `<dirname(resolvedDbPath)>/backups/state-<ISO with`:`and`.`replaced by`-`>.db`, overridable with `--backup-dir` (rebuild) / `-o, --out` (export). The parent is created `mode: 0o700`; every artifact is `chmod 0o600`. The backup carries full deployment topology and config snapshots — masked, but still sensitive — so it inherits the DB's privacy expectations rather than landing in cwd or `/tmp`. Refuses to overwrite an existing destination.
- **Restore**, printed verbatim in the success message and in the runbook:

  ```
  rfapps force-unlock                                    # only if a lock is stuck
  cp ~/.config/rfapps/backups/state-2026-07-24T18-15-00-000Z.db ~/.config/rfapps/state.db
  ```

### State-lock wiring

`resolveStateLockOperation` (`src/cli.ts:74-104`) keys on the **leaf** command name, and `"rebuild"`
is in `ALWAYS_MUTATING_COMMANDS` (`src/cli.ts:62-72`). Without a change, a read-only
`rfapps state rebuild` report would acquire the global lock labelled `"rebuild"`, indistinguishable
from container rebuild in `force-unlock` output and in the `State lock is held for rebuild by ...`
message. Add, immediately after the `parentName === "drift"` branch and **before** the
`ALWAYS_MUTATING_COMMANDS` check:

```ts
if (parentName === "state") {
  return commandName === "rebuild" && options["rewrite"] === true ? "state-rebuild" : undefined;
}
```

Result: `state export` and report-phase `state rebuild` are lock-free; only an authorized rewrite
locks, as `state-rebuild`. Acquisition and release stay entirely in cli.ts's `preAction` hook and
`main()`'s `finally` (`src/cli.ts:243-246`, `:618-639`) — **the action never calls
`acquireStateLock` itself**.

Locking before the backup is intentional: the lock is held from `preAction`, so no concurrent rfapps
mutation can write while the replacement is built and swapped. `state export` deliberately does not
lock, because the online backup API is safe under concurrent writers and a precautionary backup must
not be blocked by a stuck lock.

### Machine-format rules

`format = globalOptions.output ?? (globalOptions.json === true ? "json" : "text")`. Text renders to
**stderr only** via `logInfo`/`logWarn`/`logSuccess`. Non-text emits the whole result envelope to
stdout via `formatOutput(format, result)`. The envelope is secret-free by construction: service
names, image identity, counts, dispositions and paths — never environment values.

Machine-format rewrite requires `--yes` (guard 6). `summary.discardedDeployments` and
`summary.discardedGenerations` are always present so CI can assert the non-destructive property
directly; `database.path` and `database.isDefaultPath` are always present so automation can prove
which file was touched.

## Data structures

`src/types/state-rebuild.ts` — strict, no `any`, secret-free by construction.

```ts
import type { OutputFormat } from "@rfmedia/common";

/** Schema discriminators for the state-group result envelopes. */
export const STATE_REBUILD_SCHEMA_VERSION = "state-rebuild.v1" as const;
export const STATE_EXPORT_SCHEMA_VERSION = "state-export.v1" as const;

/** Reconstruction strategy for the replacement database. */
export type StateRebuildMode = "salvage" | "runtime-only";

/** Whether the invocation only reported or actually replaced the database. */
export type StateRebuildPhase = "report" | "rewrite";

/**
 * Disposition of one service in a rebuild sweep.
 *
 * - `reconstructed`: a baseline row was (or would be) written from observed runtime.
 * - `carried`:       readable history exists and its latest generation matches runtime.
 * - `stale`:         readable history exists but its latest generation image id differs
 *                    from runtime (or is null). Reported only — never rewritten.
 * - `orphaned`:      has state rows but is neither declared in compose nor observed.
 * - `absent`:        declared but no container was observed.
 * - `uninspectable`: observed but inspection failed; ZERO rows are written for it.
 */
export type StateRebuildDisposition = "reconstructed" | "carried" | "stale" | "orphaned" | "absent" | "uninspectable";

/** Readability of the pre-existing state database. */
export type StateDatabaseStatus = "missing" | "readable" | "unreadable";

/** How the mandatory backup artifact was produced. */
export type StateBackupMethod = "sqlite-backup" | "raw-copy";

/** Why an authorized rewrite was refused before any side effect. */
export type StateRebuildRefusalReason = "empty-plan";

/** 0 ok, 1 failed (DB unchanged), 2 invalid/cancelled/refused, 3 partial. */
export type StateRebuildExitCode = 0 | 1 | 2 | 3;

/** 0 written or dry-run, 1 failed, 2 invalid usage. */
export type StateExportExitCode = 0 | 1 | 2;

/** Raw options Commander parses for `rfapps state rebuild`. */
export interface RawStateRebuildOptions {
  mode?: StateRebuildMode;
  rewrite?: boolean;
  confirmProject?: string;
  runningOnly?: boolean;
  backupDir?: string;
  showUnchanged?: boolean;
  compose?: string;
  envFile?: string;
  profile?: string;
}

/** Raw options Commander parses for `rfapps state export`. */
export interface RawStateExportOptions {
  out?: string;
}

/** Global options forwarded from the root program. */
export interface StateCommandGlobalOptions {
  dryRun?: boolean;
  debug?: boolean;
  json?: boolean;
  output?: OutputFormat;
  verbose?: boolean;
  yes?: boolean;
  useDotenvx?: string;
  useOp?: string;
}

/** Read-only diagnosis of the pre-existing database. Never throws to produce this. */
export interface StateDatabaseProbe {
  /** Absolute resolved path (getStateDbPath). */
  path: string;
  status: StateDatabaseStatus;
  /** False when config/env redirected the path away from getDefaultDatabasePath(). */
  isDefaultPath: boolean;
  /** Stored metadata.schema_version, when readable. */
  schemaVersion?: number;
  /** Result of PRAGMA integrity_check, when readable. */
  integrity?: "ok" | "failed";
  deployments?: number;
  generations?: number;
  /** SELECT DISTINCT service FROM deployments, sorted. */
  trackedServices?: string[];
  oldestTimestamp?: string;
  newestTimestamp?: string;
  /** Sanitized diagnostic for `unreadable`. */
  reason?: string;
}

/** The mandatory pre-rewrite (or explicit export) backup artifact. */
export interface StateBackupResult {
  path: string;
  method: StateBackupMethod;
  bytes: number;
  /** Sidecar files copied alongside the database in raw-copy mode. */
  sidecars: string[];
}

/** Row-level accounting for salvage carry-over. Always present for `rewrite`. */
export interface CarryOverCounts {
  deploymentsCarried: number;
  deploymentsDiscarded: number;
  generationsCarried: number;
  generationsDiscarded: number;
  /** Generations re-derived from carried deployments (source had none). */
  generationsDerived: number;
}

/** Per-service outcome (secret-free; env values are never surfaced here). */
export interface StateRebuildServiceResult {
  service: string;
  disposition: StateRebuildDisposition;
  /** Container name from `docker compose ps --all`. */
  container?: string;
  /** Observed container state (e.g. "running", "exited"). */
  containerState?: string;
  imageTag?: string;
  imageId?: string;
  imageDigest?: string;
  /** image_id of the latest carried generation, used for stale detection. */
  recordedImageId?: string;
  /** True only when a baseline row was written for this service. */
  written: boolean;
  deploymentId?: number;
  /** Actual generation number assigned by createGeneration (never assumed). */
  generation?: number;
  reason?: string;
}

/** Aggregate counts across the sweep. */
export interface StateRebuildSummary {
  declared: number;
  observed: number;
  reconstructed: number;
  carried: number;
  stale: number;
  orphaned: number;
  absent: number;
  uninspectable: number;
  /** Services with history in the source that have no row in the replacement. */
  droppedServices: string[];
  /** Always 0 for a clean salvage; the machine-checkable safety invariant. */
  discardedDeployments: number;
  discardedGenerations: number;
}

/** Structured refusal emitted instead of throwing, so machine consumers see it. */
export interface StateRebuildRefusal {
  reason: StateRebuildRefusalReason;
  message: string;
}

/** Full rebuild result for machine (`--json`/`--output`) consumers. */
export interface StateRebuildResult {
  schemaVersion: typeof STATE_REBUILD_SCHEMA_VERSION;
  operation: "state-rebuild";
  phase: StateRebuildPhase;
  mode: StateRebuildMode;
  project: string;
  composePath: string;
  database: StateDatabaseProbe;
  /** Present only when the database was actually replaced. */
  backup?: StateBackupResult;
  /** Present only for `rewrite`. */
  carryOver?: CarryOverCounts;
  services: StateRebuildServiceResult[];
  summary: StateRebuildSummary;
  refusal?: StateRebuildRefusal;
  success: boolean;
  exitCode: StateRebuildExitCode;
}

/** Full export result for machine consumers. */
export interface StateExportResult {
  schemaVersion: typeof STATE_EXPORT_SCHEMA_VERSION;
  operation: "state-export";
  database: StateDatabaseProbe;
  destination: string;
  /** Absent when `dryRun` is true. */
  backup?: StateBackupResult;
  dryRun: boolean;
  success: boolean;
  exitCode: StateExportExitCode;
}
```

`src/lib/runtime-baseline.ts` — the shared observation engine (extracted from `actions/import.ts`):

```ts
export interface RuntimeBaseline {
  readonly identity: DockerContainerIdentity;
  readonly snapshot: ConfigSnapshot;
}

export function buildConfigSnapshotFromInspect(inspect: ContainerInspect): ConfigSnapshot;

export async function captureRuntimeBaseline(
  container: string,
  options: { readonly cwd: string; readonly envTool: EnvToolExecConfig | undefined },
): Promise<RuntimeBaseline | undefined>;

export function toBaselineEntry(service: string, baseline: RuntimeBaseline, timestamp: string): StateEntryInput;
```

`src/lib/state-rebuild.ts` — SQLite-level primitives:

```ts
export async function probeStateDatabase(dbPath: string): Promise<StateDatabaseProbe>;

export async function backupStateDatabase(dbPath: string, destinationPath: string): Promise<StateBackupResult>;

export function buildReplacementDatabasePath(targetPath: string): string;

export function defaultBackupPath(dbPath: string, backupDir: string | undefined, now: Date): string;

export function carryOverState(
  source: DbConnection,
  target: DbConnection,
  generationActions: ReadonlySet<DeploymentAction>,
): CarryOverCounts;

export async function swapStateDatabase(tempPath: string, targetPath: string): Promise<void>;
```

## Module plan

| File                                                            | New/Modify | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                | ~LOC |
| --------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/rfapps-cli/src/commands/state.ts`                     | new        | `registerStateCommand(program, deps?)`: the `state` group plus `export`/`rebuild` subcommands, injectable `loadAction()`, `configureHelp({ showGlobalOptions: true })`, help epilogues, and `validateStateRebuildOptions()` (blank `--confirm-project`/`--backup-dir`, blank `--out`) run **before** the action module loads                                                                                                  | 120  |
| `packages/rfapps-cli/src/actions/state-rebuild.ts`              | new        | Orchestration only: config prologue, authorization guards 1–7, `getStateDbPath` + divergence warning, `resolveComposeProjectIdentity`, compose/observation, probe, disposition computation, refusal check, confirm, then backup → `initializeDatabase(temp)` → `carryOverState` → `recordDeployments` → `closeDatabase` → `swapStateDatabase`, with `try/finally` closing both handles and unlinking the temp file on failure | 300  |
| `packages/rfapps-cli/src/actions/state-rebuild-report.ts`       | new        | `renderStateRebuildReport(result, showUnchanged)`: stderr text renderer — database preamble, disposition sections, the "History that will be dropped (N)" section, carry-over counts, restore command. Split out to keep both files inside the ~500-line cap                                                                                                                                                                  | 150  |
| `packages/rfapps-cli/src/actions/state-export.ts`               | new        | `executeStateExport`: resolve path, probe, honour global `--dry-run` by reporting the destination without writing, delegate to `backupStateDatabase`, emit `state-export.v1`                                                                                                                                                                                                                                                  | 80   |
| `packages/rfapps-cli/src/lib/state-rebuild.ts`                  | new        | All SQLite/file primitives: `probeStateDatabase`, `backupStateDatabase`, `buildReplacementDatabasePath`, `defaultBackupPath`, `carryOverState`, `swapStateDatabase`                                                                                                                                                                                                                                                           | 330  |
| `packages/rfapps-cli/src/lib/runtime-baseline.ts`               | new        | Extracted `buildConfigSnapshotFromInspect` + `captureRuntimeBaseline` + new `toBaselineEntry`, so `import` and `state rebuild` emit byte-identical rows from one definition (an action must never import another action)                                                                                                                                                                                                      | 110  |
| `packages/rfapps-cli/src/types/state-rebuild.ts`                | new        | All contracts above                                                                                                                                                                                                                                                                                                                                                                                                           | 150  |
| `packages/rfapps-cli/src/lib/state-storage.ts`                  | modify     | `export` the module-private `GENERATION_ACTIONS` set (line 68) so `carryOverState`'s re-derivation uses the same vocabulary as `recordDeployment`                                                                                                                                                                                                                                                                             | +2   |
| `packages/rfapps-cli/src/lib/exit-codes.ts`                     | modify     | `resolveStateRebuildExitCode(result)` and `resolveStateExportExitCode(result)` beside the existing resolvers                                                                                                                                                                                                                                                                                                                  | +30  |
| `packages/rfapps-cli/src/lib/index.ts`                          | modify     | Barrel: `state-rebuild.js` and `runtime-baseline.js` symbols alongside the existing db/migrations/state-storage blocks (`state-lock` stays deliberately unexported)                                                                                                                                                                                                                                                           | +20  |
| `packages/rfapps-cli/src/types/index.ts`                        | modify     | `export * from "./state-rebuild.js";` beside the `./import.js` re-export                                                                                                                                                                                                                                                                                                                                                      | +1   |
| `packages/rfapps-cli/src/cli.ts`                                | modify     | `import { registerStateCommand }` + call it in the modular block (lines 288-293); insert the `parentName === "state"` branch in `resolveStateLockOperation` **before** the `ALWAYS_MUTATING_COMMANDS` check                                                                                                                                                                                                                   | +8   |
| `packages/rfapps-cli/src/actions/import.ts`                     | modify     | Delete local `buildConfigSnapshotFromInspect` (103-115), `captureBaseline` (123-143), the `CapturedBaseline` interface, and the inline entry construction (466-481); import from `../lib/runtime-baseline.js`; drop now-unused `parseEnvArray`/`parsePortBindings`/`maskSensitiveEnvVars`/`inspectContainers`/`inspectContainerIdentity` imports. Pure refactor, no behaviour change, no compatibility re-export              | −50  |
| `packages/rfapps-cli/src/actions/import.spec.ts`                | modify     | Repoint the direct `buildConfigSnapshotFromInspect` import to `../lib/runtime-baseline.js` and move that module into the `vi.mock` bag. All eight existing assertions unchanged — they become the regression proof for the extraction                                                                                                                                                                                         | ~10  |
| `packages/rfapps-cli/src/actions/history.ts`                    | modify     | Add the missing `"update"` to `VALID_ACTIONS` (line 111-119). It is in `DeploymentAction` (`types/state.ts:42`) but absent here, so `rfapps history --action update` throws today. In scope because the recovery runbook tells operators to verify with `rfapps history --action`                                                                                                                                             | +1   |
| `packages/rfapps-cli/src/actions/completion.ts`                 | modify     | See [Shell completion impact](#shell-completion-impact)                                                                                                                                                                                                                                                                                                                                                                       | +100 |
| `packages/rfapps-cli/src/actions/completion.spec.ts`            | modify     | `state` in the hardcoded command list; `state rebuild` Commander-parity test; fish disjointness assertion                                                                                                                                                                                                                                                                                                                     | +45  |
| `packages/rfapps-cli/src/lib/state-rebuild.spec.ts`             | new        | Real-better-sqlite3 primitive tests (tests 1–4)                                                                                                                                                                                                                                                                                                                                                                               | 200  |
| `packages/rfapps-cli/src/actions/state-rebuild.spec.ts`         | new        | Mocked action contract tests (tests 5–8)                                                                                                                                                                                                                                                                                                                                                                                      | 250  |
| `packages/rfapps-cli/src/commands/state.spec.ts`                | new        | `spawnSync` `--help` smoke test (test 9)                                                                                                                                                                                                                                                                                                                                                                                      | 60   |
| `packages/rfapps-cli/src/cli.state-rebuild.integration.spec.ts` | new        | Spawned-CLI lock-wiring test (test 10) — matches the repo's `cli.<topic>.integration.spec.ts` convention                                                                                                                                                                                                                                                                                                                      | 120  |

## Error handling

**No new error classes.** Every failure mode maps onto an existing, already-formatted class or onto
the result envelope:

| Failure                                           | Mechanism                                                                                                                                                                                                                                                                                                     | Exit |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `--rewrite` with `state.enabled === false`        | `InvalidArgumentError("--rewrite", "true", "State tracking is disabled; enable it to rebuild the state database")`                                                                                                                                                                                            | 2    |
| `--mode runtime-only` without `--confirm-project` | `InvalidArgumentError("--confirm-project", "", "Discarding existing history requires the Compose project name")`                                                                                                                                                                                              | 2    |
| `--confirm-project` mismatch                      | `InvalidArgumentError("--confirm-project", value, "Does not match the resolved Compose project", [projectName])` — the existing formatter renders `Valid values: <projectName>`                                                                                                                               | 2    |
| Machine format without `--yes`                    | `InvalidArgumentError("--yes", "false", "Machine-format rebuild requires explicit --rewrite --yes")`                                                                                                                                                                                                          | 2    |
| Unknown `--profile`                               | `InvalidArgumentError("--profile", value, "Unknown profile", config.profiles.validProfiles)`                                                                                                                                                                                                                  | 2    |
| `docker compose config` / `ps --all` failed       | `DockerCommandError("config" \| "ps", ...)` via `formatError` + `outputFormattedError`                                                                                                                                                                                                                        | 1    |
| Backup / build / swap failed                      | Caught in the action; a plain `Error` is emitted through `formatError` + `outputFormattedError` (the generic fallback formatter already yields exit 1, which is exactly right), **preceded** by an explicit operator line naming the backup path, the temp path, and `"The state database was not modified."` | 1    |
| Planned replacement would be empty                | **Not an exception.** `result.refusal = { reason: "empty-plan", message }`, emitted through the normal result path so machine consumers see it                                                                                                                                                                | 2    |
| Source database unreadable                        | **Not an error.** `database.status = "unreadable"` with a sanitized `reason` in the report                                                                                                                                                                                                                    | 0    |

Justification for reusing `InvalidArgumentError`: it already has a registered formatter mapping to
`ExitCode.UsageError` with `Valid values: ...` suggestions (`src/lib/error-formatters.ts`), which
covers every argument-shaped refusal. The empty-plan refusal is a _result_, not an exception — making
it a result keeps it in the `--json` envelope where a CI job can read it, and avoids a new class plus
a formatter registration plus two spec-file edits for one message.

`runMigrations`'s unformatted `schema_version > 3` guard can never fire on this path: it is only
called by `initializeDatabase(tempPath)` on a brand-new file, and the source is probed read-only.

## Shell completion impact

All three templates in `src/actions/completion.ts` are hand-maintained. Verified anchors:

### bash (`generateBashCompletion`, lines 27-360)

1. **Line 40** — append `state` to `local commands="... init validate mcp"`.
2. **After line ~104** — add `local state_export_opts="--out"` and
   `local state_rebuild_opts="--mode --rewrite --confirm-project --running-only --backup-dir --show-unchanged --compose --env-file --profile"`.
3. **Line 132** — add `state` to the command-detection `case "${words[i]}"` list. Without it the
   loop falls through and `rfapps state rebuild` is detected as the top-level `rebuild`.
4. **Lines 135-141** — generalize the drift-only subcommand-detection block so it also captures
   `export|rebuild` when `$cmd == "state"`.
5. **Line 209** — add `update` to the `--action` value list
   (`deploy rebuild delete rollback apply prune import`) to match the `VALID_ACTIONS` fix.
6. **After the `drift)` block (lines 328-353)** — add a `state)` dispatch block of the same shape:
   with no `$subcmd`, suggest `export rebuild` (or `$global_opts` when `$cur` starts with `-`);
   otherwise dispatch on `$subcmd` to `$state_export_opts` / `$state_rebuild_opts`.
7. Add `--backup-dir|--out)` to the `case "$prev"` value block so those complete filenames/dirs.

### zsh (`generateZshCompletion`, lines 365-807)

1. **Lines 378-405** — add `'state:Inspect, export, and reconstruct the rfapps state database'` to
   the `commands` array.
2. **Line 427** — add `state` to `__rfapps_find_command`'s `case`. That helper returns the **first**
   matching word, so without `state` present, `rfapps state rebuild` resolves to the top-level
   `rebuild` block and renders the wrong `_arguments`.
3. **Line 639** — add `update` to the `--action` value list.
4. **After the `drift)` case (lines 723-799)** — add a `state)` case of the same shape: a local
   `state_commands=( 'export:...' 'rebuild:...' )`, a `__rfapps_find_state_cmd` helper matching
   `export|rebuild`, a nested `_arguments -C ... '1: :->state_command' '*:: :->state_args'`, and an
   inner `case $state` with one `_arguments` block per subcommand.
   `--mode` completes `(salvage runtime-only)`; `--backup-dir`/`--out` use `_files`.

### fish (`generateFishCompletion`, lines 812-1148)

1. **After line 886** — `complete -c rfapps -n "__fish_use_subcommand" -a "state" -d "Inspect, export, and reconstruct the rfapps state database"`.
2. **Lines 929-943 (deploy/rebuild block)** — append `; and not __fish_seen_subcommand_from state` to
   every line. Fish matches by **name, not position**, so `__fish_seen_subcommand_from rebuild`
   currently fires for `rfapps state rebuild` and would leak `--skip-pull`, `--force-recreate`,
   `--parallel`, `--workers`, `--wait-for-ready`, `--health-timeout`. This block is **verified
   unguarded today**. (The existing `and not __fish_seen_subcommand_from drift` guards on top-level
   `reconcile` (1013-1022) and `import` (1024-1033) are the precedent idiom.)
3. **Line 1043** — add `update` to the `--action` value list.
4. **After the drift blocks (~1146)** — add the `state` subcommand advertisement guarded by
   `__fish_seen_subcommand_from state; and not __fish_seen_subcommand_from export rebuild`, then
   per-subcommand option lines keyed on
   `__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild` (and `... export`).

### `completion.spec.ts`

- Add `"state"` to the hardcoded 25-command list (lines 152-178 → 26 entries).
- Add `getStateRebuildCompletionOptions(shell, script)` in the shape of `getImportCompletionOptions`
  (lines 83-99), with fish guard string
  `"__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild"`, and assert
  Commander parity against the registered `state rebuild` subcommand.
- Assert every fish top-level `deploy rebuild` line contains
  `not __fish_seen_subcommand_from state`.

## Docs impact

| File                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/README.md`                 | New `### state` section after `### import` (lines 406-444 are the template, including the four-row exit-code table): `state export` and `state rebuild` usage, the salvage-vs-runtime-only table, the report-first contract, the backup path and `cp` restore, the import-vs-rebuild boundary, and the exit-code table. **Amend `### State mutation locking` (lines 198-215)** — its explicit enumeration ("pull, build, deploy, stop, rebuild, delete, prune, apply, rollback, drift import, `import --adopt`, and apply modes for plan, update, and reconciliation") is the operator's stated basis for judging whether `force-unlock` is safe, so add `state rebuild --rewrite` and note that `state export` and report-phase `state rebuild` are lock-free.       |
| `docs/features/rfapps-state-rebuild.md` _(new)_ | The recovery runbook the issue asks for: symptoms (`SQLITE_NOTADB`, missing file, schema newer than the CLI, services vanished from `rfapps history`); the diagnose → `state export` → `state rebuild` (report) → `--rewrite` → verify sequence; salvage vs runtime-only decision guide; the `backups/` directory layout and the exact `cp` restore; the `rfapps force-unlock` prerequisite when a stale lock blocks the rewrite; what rebuild can and cannot recover (image identity and config snapshots yes; failed deployments, `plan_id` linkage and original deploy timestamps no); the `state-rebuild.v1` JSON contract and the `discardedDeployments`/`discardedGenerations === 0` invariant; the boundary against `rfapps import` and `rfapps drift import`. |
| `docs/README.md`                                | Link `features/rfapps-state-rebuild.md` in the CLI Features index (lines 33-90), next to `rfapps-drift-command.md` / `rfapps-reconcile-command.md`. Add a `rfapps state rebuild` row (Confirmation: "Rewrite only") to the `### rfapps CLI` command table (lines 299-312).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `docs/features/deployment-history.md`           | **Fix the wrong path**: lines 392 and 431 say `~/.local/share/rfapps/state.db`; `src/lib/db.ts` resolves `~/.config/rfapps/state.db` with a `~/.rfapps` legacy fallback. Then point `## State Database Location` (line 387) and `### Database Not Found` (line 434) at the new recovery runbook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `docs/features/shell-completion.md`             | Add `state` to the hand-maintained command list at lines 114-121 — already stale (it omits `force-unlock`, `import`, and `doctor`); fix those in the same pass. Add a `state rebuild` row to the per-command option table (lines 141-195).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ROADMAP.md`                                    | Strike Sprint 3 row 4 (line 74) as `~~[#150] …~~ — shipped <date> via [#PR](…)` per the existing `#149`/`#65` convention, and remove the `#150` row from the medium-priority backlog table (line 97), adjusting its count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/rfapps-cli/CLAUDE.md`                 | Add `commands/state.ts`, `actions/state-rebuild.ts`, `actions/state-rebuild-report.ts`, `actions/state-export.ts`, `lib/state-rebuild.ts`, `lib/runtime-baseline.ts`, `types/state-rebuild.ts` to the structure tree. Record the invariant this feature establishes: _the state database is derived and re-derivable; never open a suspect database through `initializeDatabase()`; rebuild by constructing a replacement and swapping atomically._ PR #267 set the precedent of updating this file.                                                                                                                                                                                                                                                                  |

**No `src/mcp/` changes.** `import`, `reconcile`, `doctor`, `audit` and `force-unlock` are all
deliberately absent from `RFAPPS_MCP_TOOL_NAMES` — recovery and state-repair surfaces stay CLI-only.
Reusing the `"import"` action value means the four `history --action` enums need no edit either.
_(The `VALID_ACTIONS` `"update"` fix is CLI-side only; `mcp/schema.ts:124` already lists `update`.)_

## Critical tests only

Ten tests across five files. Nothing else — the observation path is already covered by the eight
tests in `import.spec.ts`, which pass unchanged through the extraction and thereby prove
`lib/runtime-baseline.ts` still behaves.

**`src/lib/state-rebuild.spec.ts`** — REAL `better-sqlite3` on `mkdtemp` files, following the
`migrations.spec.ts` precedent (mocking SQLite here would prove nothing about SQL semantics):

1. `carryOverState` on a **v1-shaped source** (no `generations` table, no `image_id`/`image_digest`
   columns) carries deployments, re-derives generations with the current `GENERATION_ACTIONS`, and
   does not throw. — This is the exact bug that made the naive implementation inoperative on the
   legacy databases the migration system exists for.
2. `carryOverState` preserves `deployments.id` **and** `generations.generation` verbatim, keeps
   `deployment_id` FK-valid, and normalizes a `datetime('now')`-format timestamp to ISO 8601. —
   Every `rollback --to-deployment <id>` and `--to-generation N` an operator wrote down must keep
   resolving; timestamp mis-sorting silently corrupts `history --since`.
3. `carryOverState` discards and **counts** a row violating `UNIQUE(service, generation)` instead of
   aborting the transaction. — Corrupt input is the input this command exists for; a throw here
   makes the tool useless exactly when it is needed.
4. `backupStateDatabase` falls back to `method: "raw-copy"` on a file that is not a valid SQLite
   database, copies `-wal`/`-shm` siblings, and produces a mode-0600 artifact; `swapStateDatabase`
   renames atomically and removes stale `${target}-wal`/`-shm`. — The disaster path cannot depend on
   the happy path; a surviving WAL from the replaced file can be replayed onto the new database.

**`src/actions/state-rebuild.spec.ts`** — mocked, in `import.spec.ts`'s `vi.hoisted` bag style with
a `machineResult()` helper and `process.exitCode` reset:

5. Report phase (no `--rewrite`) calls neither `initializeDatabase`, `backupStateDatabase` nor
   `swapStateDatabase`, and the target file is byte-identical afterwards; the same holds for
   `--rewrite` under global `--dry-run`, which additionally warns. — The two halves of the core
   safety promise; a regression here destroys a database during a dry run.
6. A throwing `backupStateDatabase` aborts before any temp database is created, sets exit 1, and
   leaves the original file unchanged. — Proves the mandatory-backup ordering is real rather than
   aspirational.
7. `--rewrite` writes one **masked** baseline per reconstructed service (action `"import"`, status
   `"success"`, one shared ISO timestamp, identity triple, `***MASKED***` for a token env var),
   classifies a service whose recorded `image_id` differs from runtime as `stale` **without**
   rewriting it, and reports `summary.droppedServices`. — Pins row semantics, the secret-masking
   requirement (the one defect class that would write live credentials), and the rule that
   un-reconciled drift is never recorded as truth.
8. `--mode runtime-only` without a matching `--confirm-project` throws `InvalidArgumentError` before
   any backup or write; and an authorized rewrite whose plan is empty is **refused** with
   `refusal.reason === "empty-plan"` and exit 2, having written nothing. — The two gates that make
   an accidental total wipe and a "successful" empty rebuild structurally unreachable.

**`src/commands/state.spec.ts`**

9. `spawnSync("node", ["--import", "tsx", "src/cli.ts", "state", "rebuild", "--help"])` prints the
   usage line, `--mode`, `--rewrite`, `--confirm-project`, and `Global Options:`. — The cheapest
   possible proof that a brand-new nested command group is actually reachable from the root CLI.

**`src/cli.state-rebuild.integration.spec.ts`** — spawned real CLI via `testing/cli-harness.ts`,
modelled on `cli.deploy.integration.spec.ts` test D2a:

10. With a lock directory pre-created, `rfapps state rebuild` (report) still exits 0; and
    `rfapps state rebuild --rewrite --yes` exits 1 with
    `State lock is held for state-rebuild by ...`, never `for rebuild`. — `resolveStateLockOperation`
    is module-private in `cli.ts` with no unit test, and the `ALWAYS_MUTATING_COMMANDS` collision on
    the bare name `rebuild` is the highest-probability silent bug in this change. Only a spawned-CLI
    test can exercise the `parentName === "state"` branch.

Plus the two `completion.spec.ts` additions described above (command-list presence and fish
disjointness), which are extensions rather than new tests.

## Explicitly out of scope

- **Per-service scoping** (`-s/--service`, `--services`, `-g/--group`, `--no-sidecars`). A scoped
  whole-file replacement silently drops every out-of-scope service's history. `rfapps import --adopt -s <svc>`
  fills the per-service niche.
- **Unifying database path resolution.** `deploy`, `rebuild`, `history`, `rollback`, `prune`,
  `delete`, `generations` and `import` all call bare `initializeDatabase()` and ignore
  `RFAPPS_STATE_DB_PATH` / `config.state.dbPath`. This command honours `getStateDbPath` and **warns
  loudly** when the two differ. Fixing the split-brain across nine actions is a separate change.
- **A new `DeploymentAction` value.** Reconstructed rows use `"import"`. Provenance lives in the
  `state-rebuild.v1` envelope and the timestamped backup filename.
- **An MCP tool.** Established precedent: `import`, `reconcile`, `doctor`, `audit` and
  `force-unlock` are all absent from `RFAPPS_MCP_TOOL_NAMES`. Agent-initiated replacement of an
  operator's state database must stay behind a human.
- **A `--no-backup` / `--force-without-backup` escape hatch.** An unwritable backup destination is a
  genuine signal that the rewrite should not proceed.
- **Re-baselining stale services.** `state rebuild` reports them and stops. Appending a fresh
  baseline for a drifted service would record the drift as the current generation; that is
  `rfapps reconcile` / `rfapps deploy` territory.
- **A separate `rfapps state inspect` subcommand.** The report-first `state rebuild` invocation is
  the diagnosis: it already prints path, status, schema version, integrity, row counts, tracked
  services and every disposition.
- **Repairing generations from history already in the DB** without touching Docker. That is a
  different feature (a future `rfapps state repair-generations`); #150 asks for reconstruction from
  runtime. The guarded re-derivation inside `carryOverState` is a last resort, not a user-facing mode.
- **`--backup-to` for arbitrary remote/exotic destinations, dump/SQL/JSON export formats.** Restore
  must be a single `cp` an operator can perform with a broken CLI and no rfapps binary.
- **Enabling WAL mode.** The `-wal`/`-shm` handling is purely defensive cleanup.
