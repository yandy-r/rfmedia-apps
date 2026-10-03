# Spec: Lidarr Mutation Plan/Apply

## Problem Statement

Lidarr mutations currently have no rfmedia execution contract that separates review from execution,
persists the reviewed intent, or safely resumes a partial batch. Operators and automation authors need
an end-to-end plan/apply boundary before the broader bulk-management commands in issues #198–#201 can
ship without exposing unbounded or stale writes.

## Requirements

### Functional

| #   | Requirement                                                                                                                                                                                                                                                           | Priority | Notes                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Provide a versioned, secret-free `rfmedia.lidarr-plan.v1` JSON artifact with a UUID, creation metadata, canonical Lidarr origin, selected mutation, exact targets, expected-before and desired-after state, risk/cascade summary, `maxBatch`, and checksum.           | Must     | Mirror the hardened copy-plan artifact boundary in `src/lib/plan.ts`; never persist an API key.                                                                                                 |
| F2  | Add an extensible typed mutation registry whose operation definitions own validation, preview construction, stale-state comparison, scheduler lane, idempotency, execution, and deferred replay.                                                                      | Must     | Future issues add operation definitions without bypassing plan/apply or importing generated types above the Lidarr facade.                                                                      |
| F3  | Ship one complete low-level producer for exact-ID artist monitoring changes so users and tests can create and apply real plans now.                                                                                                                                   | Must     | Domain selection by album type remains #198; profile/tag targeting remains #199.                                                                                                                |
| F4  | Make planning read-only and preview-first: resolve the selected artists, reject unknown targets, compute no-op versus changed entries, render the complete bounded review, and save the artifact without issuing a mutation request.                                  | Must     | The plan must state that monitoring changes do not delete files, cancel queued downloads, or trigger searches.                                                                                  |
| F5  | Require `--max-batch` as an artifact-bound safety cap with a conservative default and validated upper bound; reject a plan whose requested or expanded targets exceed the cap.                                                                                        | Must     | This user-selected blast-radius cap is separate from the scheduler lane operation budget.                                                                                                       |
| F6  | Validate artifacts before apply with exact-key schemas, bounded arrays/strings, forbidden-key rejection, symlink and oversized-file rejection, private atomic writes, canonical checksum verification, version/operation allowlisting, and canonical-origin matching. | Must     | Corruption, tampering, unsupported versions, and target-instance mismatch are never overridable.                                                                                                |
| F7  | Re-read every target immediately before mutation and block unexpected state drift while treating an already-desired target as safely satisfied.                                                                                                                       | Must     | `--force-stale` may not bypass identity, schema, checksum, origin, or unsupported-operation failures; any narrowly overridable state finding must be explicit in the artifact and audit record. |
| F8  | Require an explicit apply gate: interactive text mode confirms by default; non-TTY or machine output requires `--yes`; global `--dry-run` validates and reports without mutation or history changes.                                                                  | Must     | Never call `process.exit()`; preserve existing output/exit conventions.                                                                                                                         |
| F9  | Execute admitted work through the shipped Lidarr scheduler and facade, preserving ordered per-target outcomes and preventing retry amplification.                                                                                                                     | Must     | Local monitoring edits are idempotent `local-only` work; file-deleting operations remain destructive and are out of scope.                                                                      |
| F10 | Persist authoritative per-target apply history after each terminal outcome and support explicit `--resume` that skips succeeded/satisfied targets and retries only incomplete eligible work.                                                                          | Must     | History cannot be a best-effort warning if it is used to suppress re-execution.                                                                                                                 |
| F11 | Register explicit deferred-intent executors for the shipped mutation kind; retryable failures may be queued idempotently, and `apply --resume` is the only automatic entry point for replay.                                                                          | Must     | Health/status/unrelated commands must never trigger mutations.                                                                                                                                  |
| F12 | Render stable human and JSON/YAML/CSV plan/apply envelopes containing plan identity, risk, counts, lane, per-target outcomes, deferred state, and completion status.                                                                                                  | Must     | Machine output remains on stdout; diagnostics remain on stderr.                                                                                                                                 |
| F13 | Update Bash, Zsh, and Fish completion templates and parity tests for every new Lidarr subcommand, option, and choice.                                                                                                                                                 | Must     | Command-surface parity is part of completion, not follow-up work.                                                                                                                               |
| F14 | Document the workflow and schema, update `ROADMAP.md`, and leave #198–#201 explicitly open as higher-level consumers.                                                                                                                                                 | Must     | No child issue is required to complete #202.                                                                                                                                                    |

### Non-Functional

| #   | Requirement          | Target                                                                                                                                            | Rationale                                                                                   |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| NF1 | Secret safety        | No API keys, auth headers, environment values, or raw generated response bodies in plans, history, logs, or machine envelopes                     | Plans are intended to be reviewable and shareable.                                          |
| NF2 | Determinism          | Canonical ordering and byte-stable checksum input for semantically identical plans                                                                | Reliable tamper detection and useful diffs require deterministic serialization.             |
| NF3 | Bounded resource use | 10 MiB artifact cap, finite target cap, bounded strings, and scheduler-enforced admission                                                         | Untrusted or accidental large artifacts must not exhaust memory or create unbounded writes. |
| NF4 | Crash/partial safety | A durable terminal record is written per target before later targets are admitted; resume never repeats a recorded success                        | Partial batches must be auditable and safely continuable.                                   |
| NF5 | Compatibility        | Preserve all four existing Lidarr read commands, generated-client privacy rules, Node 22 support, and current error/output semantics              | The mutation framework is additive.                                                         |
| NF6 | Testability          | Deterministic clock/UUID/filesystem/client/scheduler seams with focused unit, integration, CLI, completion, architecture, and full-suite coverage | Safety behavior must not depend on live Lidarr access.                                      |

## Technical Approach

**Strategy**: Introduce a strict registry-driven Lidarr mutation engine beneath two new CLI leaves,
`lidarr plan` and `lidarr apply`. The first built-in operation plans exact-ID artist monitoring
changes; later domain commands build the same typed drafts and reuse the engine rather than gaining
direct write access.

**Architecture Decisions**:

- Registry-owned operations: each mutation kind supplies its own narrow payload validator, current
  state projection, risk/cascade summary, scheduler task, and deferred executor so schema and runtime
  behavior cannot drift apart.
- Desired-state artifacts: persist expected-before and desired-after projections rather than raw API
  payloads; this makes stale checks, idempotency, review, and resume deterministic.
- Hardened artifact boundary: mirror copy-plan canonicalization, checksum, safe I/O, and exact-schema
  validation while keeping the Lidarr schema separate and operation-aware.
- Authoritative granular history: use durable per-target outcomes as resume state; do not reuse the
  copy plan's non-blocking aggregate audit warning as an execution authority.
- Facade-only mutation: add a narrow artist-monitoring method to `LidarrClientApi`; only the private
  client module may call the generated artist-editor endpoint.
- Explicit replay only: integrate the existing deferred-intent registry with `apply --resume`; no
  background or health-triggered mutation path is introduced.

**Key Components**:

- `src/types/lidarr-plan.ts`: versioned artifact, operation, risk, drift, outcome, history, and output
  contracts.
- `src/lib/lidarr/plan-engine.ts`: registry, canonicalization, validation, checksum, hardened I/O,
  staleness checks, history, resume selection, and deferred executor mapping.
- `src/actions/lidarr/plan.ts`: read-only target resolution, preview rendering data, and artifact
  generation.
- `src/actions/lidarr/apply.ts`: apply gates, immediate revalidation, scheduler dispatch, durable
  per-target history, deferral, and resume.
- `src/lib/lidarr/client.ts`: narrow validated artist-monitoring mutation facade over the generated
  SDK.
- `src/commands/lidarr.ts`: `plan artist-monitoring` and `apply` CLI contracts with human/machine
  output parity.

## Integration Points

| System/Service              | Direction | Protocol                                 | Notes                                                                                                       |
| --------------------------- | --------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Lidarr local API            | Outbound  | HTTPS/REST                               | Planning reads artists; apply uses the private generated artist-editor call through the handwritten facade. |
| Lidarr scheduler            | Both      | In-process typed API                     | Enforces lane concurrency, admission budget, cancellation, ordering, and retry ownership.                   |
| Deferred-intent store       | Both      | SQLite                                   | Stores idempotent retryable work and replays only through explicit resume.                                  |
| Plan/history storage        | Both      | Private local JSON/JSONL or SQLite state | Plans are shareable and secret-free; granular history is durable execution authority.                       |
| Shell completion generators | Outbound  | Bash/Zsh/Fish scripts                    | Must mirror the complete new command surface.                                                               |
| Output formatters           | Outbound  | Text/JSON/YAML/CSV                       | Plan and apply use stable envelopes with no mixed stdout diagnostics.                                       |

## Risks & Unknowns

| Risk                                                                                | Likelihood | Impact | Mitigation                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated OpenAPI declares `200` while Lidarr controllers may return `202 Accepted` | M          | H      | Treat any valid successful 2xx with bounded body handling as success at the private facade boundary.                                                                  |
| Concurrent processes apply the same plan                                            | M          | H      | Add a per-plan exclusive claim/lock and fail closed when another live apply owns it; exercise crash recovery behavior in tests.                                       |
| Audit persistence fails after a remote mutation succeeds                            | L          | H      | Make per-target outcome persistence authoritative and fail closed before admitting further targets; surface the recovery state for explicit resume.                   |
| Current state changes between preflight and request                                 | M          | M      | Keep the read/write window small, use desired-state idempotency, and record the exact observed state and outcome.                                                     |
| Generic registry becomes speculative abstraction                                    | M          | M      | Ship only the contracts needed by the real artist-monitoring operation and deferred executor; require future kinds to add their own tests.                            |
| Scope leaks into #198–#201                                                          | M          | M      | Limit #202 to exact artist IDs and monitoring desired state; preserve album-type selection, profile/tag UX, deletion/file impact, and import/export for their issues. |

## Open Questions

- [x] Scope: ship the reusable framework plus exact-ID artist monitoring; #198–#201 remain separate consumers.
- [x] Staleness: already-desired state is satisfied; unexpected before-state drift blocks and is not silently forced.
- [x] Resume: explicit `apply --resume` uses durable per-target history and registered deferred executors; no incidental replay.
- [x] Plan identification: bind to the canonical Lidarr origin without storing credentials.
- [x] Command surface: add `lidarr plan artist-monitoring` and `lidarr apply`, with all three completion templates updated.

---

_Source: GitHub issue #202, `research/rfmedia-lidarr-integration/`, `ROADMAP.md`, and repository grounding_
_Generated: 2026-07-22T00:00:00Z_
_Status: IMPLEMENTED — validated 2026-07-22_
