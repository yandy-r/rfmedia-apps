# Context Analysis: Metadata Drift Reconciliation

## Executive Summary

Issue #125 adds a new top-level `rfmedia reconcile scan|apply` workflow that compares embedded
audio metadata, operation-scoped SQLite inventory, and a fresh provider-neutral media-server
snapshot. It must remain distinct from both `rfmedia plex sync` (two-plane, rating-only, and
legacy opt-in dry-run behavior) and `rfmedia lidarr reconcile` (report-only artist identity).

The implementation should preserve the repository's command/action/library boundaries:
Commander owns grammar and presentation, an injected action owns resource acquisition and
lifecycle, and a pure reconciliation library owns normalization, classification, planning, and
deterministic ordering. Scan and default apply preview use the hardened read-only database path
and perform no incidental writes. Executed apply requires exactly one explicit winner flag,
`--execute`, and either default-No interactive confirmation or `--yes`; the action must repeat
that authorization before opening any writable resource.

V1 observes rating, artist, first genre, and year where the source exposes them, but apply requests
rating repair only plus exact stale-stat refresh. File writes are further limited to MP3 and FLAC.
Known requested-plan blockers fail closed unless `--allow-partial` is explicit; unsupported
targets, ambiguous identity, missing authority, stale evidence, partial cross-resource results,
and post-apply residuals must remain typed report data rather than being silently treated as
convergence. The final plan must encode the revised feature specification and resolve the remaining
implementation choices listed below before implementation begins.

## Architecture Context

The required dependency direction is:

```text
src/cli.ts
  -> commands/reconcile.ts
    -> actions/reconcile.ts
      -> lib/reconciliation.ts
        -> lib/db.ts
        -> lib/metadata.ts + lib/tag-writer.ts
        -> MediaServerAdapter
```

- **Command boundary:** Register the root namespace, define `scan` and `apply`, validate cheap
  syntax and winner-flag mutual exclusion before lazy action loading, render human or machine
  results, prompt only when allowed, and set `process.exitCode`. It must not acquire the database,
  media server, or file writer.
- **Action boundary:** Resolve configuration, database precedence, library scope, and the required
  media-server adapter; acquire all evidence completely; call the pure engine; repeat execution
  authorization; delay writable dependencies until approval; coordinate revalidation, mutation,
  cancellation, and post-apply verification; and return data without printing.
- **Pure reconciliation boundary:** Represent each plane's state explicitly, canonicalize values,
  preserve raw presentation values, join only unambiguous exact identities, classify stable
  findings, produce capability-aware target plans, and sort all findings/outcomes
  deterministically. It performs no I/O.
- **Database boundary:** Use `openDatabaseReadOnly()` for scan and preview. Add named, typed,
  bounded inventory queries that preserve operation provenance and duplicate evidence. Executed
  updates must target one row by ID plus expected prior identity/value/stat facts in a short
  transaction; do not use replacement semantics or delete historical stale rows.
- **File boundary:** Discover only regular, non-symlink audio files inside the selected root.
  Wrap `readExtendedMetadata()` so parse failure is distinct from missing metadata. Revalidate
  identity and stat evidence immediately before mutation, validate normalized ratings before
  calling `writeRating()`, and verify the resulting value.
- **Media-server boundary:** Resolve and use only `MediaServerAdapter`. Drain a complete,
  response-driven track snapshot, retain opaque IDs only after an unambiguous exact path match,
  and call only the public rating capability. No reconciliation module may import Plex wire types,
  endpoints, clients, or native rating rules.
- **Output boundary:** Return one versioned deterministic result. JSON and YAML retain the nested
  evidence; CSV uses an explicit fixed row-kind schema instead of generic nested flattening.
  Machine stdout contains exactly one document, while progress, prompts, and diagnostics remain
  on stderr.

## Critical Files Reference

| Exact path                                                          | Implementation responsibility                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/125-metadata-drift-reconciliation/feature-spec.md`      | Authoritative issue scope, safety, result, and success contract after the flagged design conflicts are resolved.                               |
| `docs/plans/125-metadata-drift-reconciliation/shared.md`            | Consolidated repository map and mandatory implementation references.                                                                           |
| `packages/rfmedia-cli/src/cli.ts`                                   | Register the new top-level command without changing global output-option reconciliation.                                                       |
| `packages/rfmedia-cli/src/commands/reconcile.ts`                    | New thin `scan`/`apply` grammar, one-of winner validation, lazy action loading, prompting, rendering, and exit behavior.                       |
| `packages/rfmedia-cli/src/actions/reconcile.ts`                     | New injected acquisition, preview, authorization, revalidation, mutation, verification, and partial-result lifecycle.                          |
| `packages/rfmedia-cli/src/types/reconciliation.ts`                  | New readonly evidence, finding, strategy, target-outcome, summary, result, and stable reason-code contracts.                                   |
| `packages/rfmedia-cli/src/lib/reconciliation.ts`                    | New pure exact-path join, normalization, classification, capability planning, aggregation, and deterministic ordering.                         |
| `packages/rfmedia-cli/src/lib/db.ts`                                | Add bounded operation-aware inventory reads and exact optimistic updates while preserving hardened snapshot behavior.                          |
| `packages/rfmedia-cli/src/types/db.ts`                              | Add validated projections/guards for the reconciliation-specific inventory query and update contracts.                                         |
| `packages/rfmedia-cli/src/lib/schema.sql`                           | Reference schema-v11 inventory shape only; V1 should not require a migration.                                                                  |
| `packages/rfmedia-cli/src/lib/inventory.ts`                         | Establish which metadata fields production inventory actually populates; do not reinterpret absent columns as clear intent.                    |
| `packages/rfmedia-cli/src/lib/audio.ts`                             | Existing discovery follows symlinks and is unsafe as an apply authority; reuse only after adding or wrapping no-follow root-bounded discovery. |
| `packages/rfmedia-cli/src/lib/metadata.ts`                          | Existing read projection for rating, artist, genre, year, and other tags; wrap its `null` error collapse into typed observations.              |
| `packages/rfmedia-cli/src/lib/ratings.ts`                           | Canonical file-rating normalization and format-specific absence semantics.                                                                     |
| `packages/rfmedia-cli/src/lib/tag-writer.ts`                        | Existing MP3/FLAC rating mutation and explicit unsupported-format result contract.                                                             |
| `packages/rfmedia-cli/src/types/media-server.ts`                    | Provider-neutral track projection, native rating step, query, and rating-mutation capabilities.                                                |
| `packages/rfmedia-cli/src/lib/adapters/index.ts`                    | Existing adapter and credential resolution; do not duplicate token precedence.                                                                 |
| `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`       | Complete response-driven paging precedent behind the adapter.                                                                                  |
| `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`             | Current generic track fields and the absence of projected track genre data.                                                                    |
| `packages/rfmedia-cli/src/actions/plex-sync.ts`                     | Reuse exact-path/rating concepts and pagination patterns, but not its mutation-default behavior.                                               |
| `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts`             | Reuse thin command, dependency injection, machine-envelope, and lazy-load patterns.                                                            |
| `packages/rfmedia-cli/src/actions/lidarr/reconcile.ts`              | Reuse complete acquisition and deterministic report patterns, not its identity cache semantics.                                                |
| `packages/rfmedia-cli/src/lib/parallel.ts`                          | Bounded input-indexed work with cooperative cancellation.                                                                                      |
| `packages/rfmedia-cli/src/lib/signal-handler.ts`                    | Process-wide cancellation signal for phase and per-target admission checks.                                                                    |
| `packages/rfmedia-cli/src/lib/formatters/index.ts`                  | Shared JSON/YAML/CSV serialization and CSV formula neutralization.                                                                             |
| `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` | Add the identical static root hierarchy and exact leaf options in all shells.                                                                  |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`  | Lock Bash, Zsh, and Fish hierarchy, option, and strategy-value parity.                                                                         |

## Data Flow

### Scan and apply preview

1. Commander validates the source path, positive integer options, output constraints, and, for
   apply, exactly one of `--file-wins`, `--db-wins`, or `--server-wins`.
2. The action resolves the existing tracking database using the repository's established
   precedence and opens it with `openDatabaseReadOnly()`. It must not initialize, migrate,
   checkpoint, create sidecars, or write history.
3. The action enumerates root-bounded regular audio files without following symlinks, captures
   stable stat identity, and reads bounded metadata into typed per-plane observations.
4. It queries inventory candidates without collapsing rows from different operations. An explicit
   `--operation-id` narrows the generation; otherwise conflicting candidates remain ambiguous.
5. It resolves the configured adapter and fully drains the selected library. Empty paths and
   duplicate exact paths remain unmatched or ambiguous; titles and basenames never become identity.
6. The pure engine indexes all three planes, canonicalizes field values, classifies findings,
   calculates per-target writability, and produces deterministic summaries and detailed rows.
7. `scan` returns the report. `apply` computes the selected-authority target plan and returns the
   same complete preview unless execution is independently authorized.

### Executed apply

1. Require a winner flag plus `--execute`; require default-No TTY confirmation unless `--yes`, and
   require `--yes` in machine or non-interactive execution. `--yes` alone remains inert.
2. Reacquire the authoritative evidence immediately before mutation. Do not trust an earlier
   invocation, a cached provider response, the preview's in-memory assumptions, or mtime alone.
3. Before the first write for each record, revalidate the exact file, database row, server item,
   authority value, and intended targets against reviewed evidence. Changed or ambiguous evidence
   produces a stale outcome and no write for that record.
4. Attempt supported external file/server targets before the SQLite target. Stop later targets for
   that record after a failure, retain completed outcomes, and never claim a cross-resource
   transaction.
5. Perform an exact optimistic SQLite update only after external targets have succeeded.
6. Re-scan touched records using fresh evidence and report `resolved`, residual,
   `unsupported-target`, failed, stale, and partial outcomes truthfully.
7. Close the database and stop admitting new work on cancellation. Operational failure or an
   incomplete requested execution is nonzero; a trustworthy scan containing ordinary drift is
   successful data.

## Field and Identity Constraints

| Field    | File evidence                            | Database evidence                   | Server evidence                                | V1 write capability                                              |
| -------- | ---------------------------------------- | ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `rating` | Normalized, with format-specific absence | Usually populated                   | Normalized with adapter-native precision       | MP3/FLAC file, exact DB row, and public server rating capability |
| `artist` | Primary normalized text                  | Column exists but is usually absent | Projected                                      | Exact DB row only                                                |
| `genre`  | First normalized genre                   | Column exists but is usually absent | Currently unavailable in Plex track projection | Exact DB row only                                                |
| `year`   | Validated safe integer                   | Column exists but is usually absent | Projected                                      | Exact DB row only                                                |

- Preserve `present`, `missing`, `unavailable`, `invalid`, and `read-failed` as distinct evidence
  states. Missing/unrated is not numeric zero, and a database `NULL` is not an instruction to clear
  another plane.
- Ratings compare in normalized `0..1` space using the adapter's declared native precision rather
  than an arbitrary float tolerance.
- Artist and genre comparison may normalize Unicode, trim whitespace, and case-fold, but output
  preserves the selected source text.
- Year input must be a finite safe integer within the documented media range.
- Identity is a normalized absolute path contained by the selected root. Empty, relative,
  escaping, symlinked, duplicate, mount-remapped, basename-only, or multi-match evidence must not
  be guessed.
- Inventory remains operation-scoped historical evidence. Repeated destination claims must remain
  visible unless `--operation-id` makes the row unique.
- `plex_queries` and `plex_query_results` are historical provider-specific query data, not a
  provider-neutral authoritative snapshot, and must not be used for this feature.

## Safety, Failure, and Compatibility Requirements

- Strategy selects policy only. It never authorizes execution, implies confirmation, or weakens
  evidence checks.
- Scan, default apply preview, declined confirmation, `--yes` without `--execute`, and invalid
  machine execution must perform zero writes and must not acquire writable dependencies.
- The action repeats all mutation gates so direct callers cannot bypass Commander.
- Missing authority never falls back to another plane. Unsupported target capability is not
  convergence and must have a stable reason code.
- SQLite, the filesystem, and the media server cannot share a transaction. Preserve exact
  per-target outcomes, conservative write ordering, post-write verification, and idempotent rerun
  behavior.
- A selected inventory row that changes after review must fail its guarded update rather than
  becoming last-writer-wins. Do not use `INSERT OR REPLACE`.
- Do not delete stale inventory rows, create files, rewrite paths, or infer server identity.
- Do not persist provider snapshots or reconciliation plans and do not add a schema migration for
  V1.
- Keep provider wire types, credentials, URLs, cache details, native scales, raw responses, and
  unbounded errors below the adapter. Redact credential-bearing and control-character data.
- Structured output selection is not approval. JSON/YAML/CSV execution still requires
  `--execute --yes` and never prompts.
- Preserve existing `plex sync` and `lidarr reconcile` syntax and behavior. The new root namespace
  needs unique command identifiers and explicit documentation disambiguation.
- Add the new root and both leaves to Bash, Zsh, and Fish together. Completion must remain static
  and perform no file, config, database, provider, prompt, or mutation work.
- Avoid dependency churn and generated-client changes. Extend provider-neutral adapter contracts
  only if a validated freshness or cancellation requirement cannot be met through existing seams.

## Critical Test Evidence

The final plan should keep tests contract-focused:

1. Pure engine tables for exact-path identity, missing versus invalid/unavailable evidence,
   normalization, ambiguity, finding precedence, winner planning, capability residuals, and stable
   ordering.
2. Database tests with real temporary SQLite fixtures for root/operation selection, duplicate
   preservation, deterministic empty results, exact optimistic updates, and refusal after a
   concurrent change.
3. Action tests proving scan and preview acquire no writable dependency; authorization precedes
   mutation resources; supported rating repair updates only losing planes and is post-verified;
   changed evidence blocks a write; and a mid-record failure remains a nonzero partial result.
4. Command tests proving zero/multiple winner flags fail before action loading, `--execute` and
   `--yes` have independent semantics, machine execution never prompts, structured output is
   singular, CSV uses fixed row kinds, and exit codes distinguish drift from operational failure.
5. Existing completion-template tests extended once to assert identical Bash/Zsh/Fish hierarchy,
   leaf option placement, and winner candidates.

Do not duplicate existing exhaustive coverage for database snapshot hardening, file-format rating
implementation, Plex transport/native conversion, or generic serializers unless the new code
changes those contracts.

## Documentation and Release Surfaces

- Create `packages/rfmedia-cli/docs/features/metadata-reconciliation.md` as the canonical operator
  guide for scope, syntax, findings, capability matrix, safety ceremony, output, exits, partial
  results, and troubleshooting.
- Update `packages/rfmedia-cli/README.md`, `docs/README.md`, and optionally the root `README.md` for
  discovery and concise examples without duplicating the full guide.
- Update `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md` for operation scope,
  absent metadata evidence, read-only scan, guarded updates, retained stale history, and the lack
  of a new migration.
- Update `docs/features/output-formats.md` so machine mode never implies `--yes`, and document the
  reconciliation result/CSV projection without broadening rfapps-only dry-run or JSON guides.
- Update `packages/rfmedia-cli/docs/features/shell-completion.doc.md` and the executable static
  templates in parallel; correct safety-critical stale global-`--dry-run` prose where directly
  touched.
- Add an `[Unreleased]` entry to `packages/rfmedia-cli/CHANGELOG.md`.
- Update `ROADMAP.md` and `docs/roadmap-archive.md` only from live issue counts and the real merged
  pull request. Do not predeclare issue #125 shipped.
- Build the pull request body from `.github/pull_request_template.md`, retain all required
  sections, use `Closes #125`, and list exact commands with pass/fail results.

## Unresolved Decisions the Final Plan Must Encode

1. **Winner syntax — resolved:** Use exactly one of `--file-wins`, `--db-wins`, or
   `--server-wins` in the command, action, completion, test, and documentation tasks.
2. **Unsupported-field execution policy — resolved:** V1 apply requests rating repair and exact
   stale-stat refresh only. Non-rating fields remain observation-only. Known requested-plan
   blockers prevent all writes unless `--allow-partial` is explicit; partial execution remains
   nonzero while requested drift remains.
3. **Inventory join identity:** Research alternates between source path, destination path, and
   canonical artifact language. Specify exactly which inventory path is compared to the local
   source root and server path, how relative paths participate, and which captured row facts guard
   an update.
4. **Fresh server evidence:** The adapter query surface exposes neither an explicit cache bypass
   nor `AbortSignal`. Decide whether a fresh adapter instance is sufficient or a small
   provider-neutral query option must be added for authoritative pre/post scans. Do not accept a
   possibly cached postcondition.
5. **Cancellation scope:** Decide whether cooperative cancellation between pages/writes satisfies
   V1 or whether the public query and metadata capabilities require signal support. If extended,
   keep the change provider-neutral and test existing adapters.
6. **Absent-value write semantics:** Define whether any winner can intentionally clear a rating or
   database metadata value. Until explicit clearing is designed and supported by each target,
   missing authority should remain unresolved and non-mutating.
7. **Apply postcondition:** Define whether success means no supported drift for the explicitly
   requested field set or no residual drift of any observed field. This must agree with the
   unsupported-field policy and exit-code contract.
8. **Database precedence wording:** Documentation research and older README text disagree on XDG
   versus legacy database preference. Verify `resolveTrackingDatabasePath()` and make the command
   guide, README, and centralized database guide match the implementation.
9. **Global output formats:** The feature spec names JSON/YAML/CSV while the root CLI also supports
   text/table modes. Specify the human/table behavior and preserve the root option source rules
   without inventing command-local format flags.

These are design decisions, not implementation details. The final dependency-aware plan should
place their resolution before shared types, command grammar, tests, completions, or public
documentation are assigned.
