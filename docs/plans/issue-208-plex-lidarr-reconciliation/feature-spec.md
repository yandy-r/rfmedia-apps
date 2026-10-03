# Feature Specification: Plex-Lidarr Reconciliation and Gap Analysis

- **Issue:** #208
- **Command:** `rfmedia lidarr reconcile`
- **Status:** Design complete
- **Release boundary:** Report-first, artist-level v1

## Executive Summary

Issue #208 adds a deterministic, bidirectional artist reconciliation report between one Plex music
library and one Lidarr instance. The command reports authoritative exact matches, review-only name
evidence, `plex_only` and `lidarr_only` gap sets, uncertainty states, optional duplicate findings,
and inert remediation suggestions. It supports live acquisition and a strict offline mode backed by
a complete cached snapshot.

The implementation composes the provider-neutral Plex identity capability, the handwritten Lidarr
client facade, and the identity resolver shipped by #207. It does not introduce a second matcher,
another authenticated transport, or direct provider endpoints. A pure bridge projector owns set
arithmetic and report classification; an action owns live/offline acquisition and cache lifecycle;
a dedicated command module owns validation and presentation.

Two prerequisite deficiencies in snapshot v1 must be fixed:

1. Snapshot v1 does not retain the complete Lidarr artist catalog, so an offline run cannot name
   every `lidarr_only` artist.
2. Existing cache reads require Plex machine and library IDs that cannot be discovered from Plex
   during a true offline run.

Snapshot v2 therefore retains a bounded minimal Lidarr catalog and the cache owner gains a
credential-free compatible-scope selector. Old v1 documents remain incompatible and require an
online refresh; they are never guessed, merged, or silently upgraded.

The default and offline commands never mutate Plex, Lidarr, files, monitoring state, or plan
artifacts. A successful live run may atomically replace its observational SQLite snapshot after all
evidence validates. That cache write is durability for later reporting, not provider mutation.
There is no `--apply` option in v1. Corrective actions belong to #209/#221 or another focused issue
and must use the existing sealed plan/apply lifecycle with fresh live revalidation.

## Scope and Non-Goals

### In scope

- One complete Plex music-library artist catalog compared with one complete Lidarr artist catalog.
- Unique one-to-one artist MBID joins as the only authoritative matches.
- Name-derived normalized and fuzzy candidates as bounded review evidence only.
- Deterministic `plex_only` and `lidarr_only` directional sets.
- Explicit ambiguous, conflict, unmatched, and unavailable evidence.
- Optional bridge-relevant duplicate detection.
- Inert remediation suggestions, including references to existing sealed planning workflows.
- A live online path that refreshes one complete snapshot atomically.
- A strict `--offline` path with zero provider I/O and visible cache age/scope provenance.
- Human, JSON, YAML, and CSV output with equivalent data.
- Stable exit behavior, cancellation, secret redaction, shell completion parity, and documentation.
- Reuse of the pure reconciliation result by future audit integration.

### Out of scope

- Album, track, file, play-count, rating, quality-profile, root-folder, or monitoring-state
  reconciliation.
- Automatic artist addition, removal, merge, unmonitoring, retagging, Plex scans, or filesystem
  changes.
- `--apply`, confirmation prompts, plan creation, or plan execution in this command.
- Treating a fuzzy or normalized-name score as probability, confidence, or mutation authority.
- Using cached evidence to authorize any mutation.
- MusicBrainz network calls, continuous reconciliation, watch/daemon behavior, or a generic sync
  framework.
- Activating a second independent `lidarr audit plex-alignment` matcher.
- Consumption-driven policy from #209 and preference/ratings policy from #221.

## Child Issue Decomposition

Two child tracking issues are required even if both are delivered by one cohesive pull request.
This resolves the analysis disagreement by preserving explicit dependency and acceptance evidence
without forcing an artificial merge boundary.

### Child A: Cache v2 completeness and offline scope selection

**Purpose:** make a truthful bidirectional offline report possible.

**Owns:**

- Snapshot-v2 domain contract and complete minimal Lidarr target catalog.
- Strict v2 validation, round-trip persistence, and v1 incompatibility behavior.
- Credential-free canonical-origin resolution for offline selection.
- Zero/one/many compatible-scope lookup with optional stable Plex library ID filtering.
- Cache and mapping tests covering completeness, bounds, atomicity, and scope isolation.

**Exit evidence:** a complete v2 snapshot can round-trip and reproduce all reverse gaps without
provider construction; ambiguous scopes fail closed.

### Child B: Read-only reconciliation workflow and public surfaces

**Depends on:** Child A's frozen v2 and scope-selection contracts.

**Owns:**

- Pure bidirectional reconciliation engine.
- Live/offline action orchestration and cancellation.
- `rfmedia lidarr reconcile` registration, validation, presenters, and failure envelopes.
- Optional duplicate findings and inert remediation suggestions.
- Bash, Zsh, and Fish completion parity.
- User documentation, audit handoff wording, and ROADMAP updates.

**Exit evidence:** live and offline executions produce equivalent classifications from the same
snapshot, all public formats agree, and the command performs no provider mutation.

### Delivery rule

One PR may close both children and #208 when:

- Child A changes are implemented and tested before Child B consumes them.
- The PR body and commits identify the dependency order.
- Testing evidence is grouped by each child contract.
- Review can verify cache/offline safety independently from CLI/presentation behavior.

Provider mutations must not be added as a third child under this delivery. They remain owned by
issues #209 and #221 or a separately approved issue.

## User Stories

1. As an operator, I can run `rfmedia lidarr reconcile --plex-library Music` and see which artists
   exist only in Plex, only in Lidarr, or are authoritatively linked.
2. As an operator, I can distinguish unique exact MBID matches from normalized/fuzzy suggestions,
   ambiguity, conflicts, and missing evidence without interpreting a score as certainty.
3. As an operator, I can add `--duplicates` to see bounded identity collisions and safe next-step
   suggestions without changing either provider.
4. As an operator during an outage, I can run the command with `--offline` and receive the same
   report schema from exactly one compatible cached scope, with age and stale provenance visible.
5. As an automation author, I receive stable JSON, YAML, or CSV fields, deterministic ordering, and
   exit code 0 when gaps are found.
6. As a security-conscious operator, I know that neither live nor offline reconciliation can add,
   delete, merge, retag, or unmonitor an artist.
7. As a maintainer, I can reuse one pure engine for later audit integration without duplicating
   title matching or crossing private provider boundaries.

## Business Rules

1. A unique one-to-one artist MBID join is the only authoritative match.
2. `normalized-name` and `fuzzy-name` results are review evidence regardless of score.
3. Existing resolver policy remains authoritative: score floor `0.90`, runner-up margin `0.08`,
   maximum five retained candidates, 10,000 artists per side, 16 MiB normalized text, and one
   million pairwise comparisons.
4. A score is similarity evidence in `[0, 1]`; it is not rendered as a percentage or named
   confidence.
5. A Plex artist is removed from `plex_only` only by an authoritative exact match.
6. A Lidarr artist is removed from `lidarr_only` only when consumed by one authoritative exact
   match.
7. A suggested pair may appear in both directional gaps until reviewed. Suggestions and gap sets
   intentionally overlap.
8. Every Plex source has exactly one resolver outcome. Derived gap, duplicate, and suggestion
   arrays may overlap that primary outcome and must not be summed as disjoint totals.
9. A Lidarr target may be consumed by at most one authoritative match. Duplicate or contradictory
   MBID evidence is a conflict, never first-row-wins.
10. Empty Plex, empty Lidarr, and both-empty catalogs are valid when enumeration completed.
11. Partial, stalled, cancelled, truncated, or scope-changing enumeration is not an empty catalog
    and cannot produce or replace a complete snapshot.
12. Gaps, suggestions, ambiguity, conflicts, and duplicate findings are successful report data.
13. Missing/incompatible/ambiguous offline scope, corrupt cache, incomplete live evidence,
    provider failure, and cache durability failure are operational failures.
14. Live failure never silently falls back to cache. Cached evidence is used only after explicit
    `--offline`.
15. Offline evidence is always labeled stale even when it passes strict validation.
16. Duplicate detection is opt-in and reports identity evidence only. Deep Lidarr path, folded-name,
    album, and file duplicate checks remain owned by
    `rfmedia lidarr audit --check duplicate-identity`.
17. Remediation suggestions are data. They do not create a plan, run apply, prompt, or call a
    mutation method.

## Result/Data Contracts

### Snapshot v2

`BRIDGE_IDENTITY_SNAPSHOT_VERSION` advances from `1` to `2`. The existing SQL table and unique
scope key remain unchanged because `payload_json` and version columns already model document
evolution.

```ts
interface BridgeTargetArtist {
  readonly lidarrId: number;
  readonly title: string;
  readonly artistMbid: string | null;
}

interface BridgeArtistIdentitySnapshotV2 {
  readonly snapshotVersion: 2;
  readonly resolverVersion: 1;
  readonly normalizationVersion: 1;
  readonly scoringVersion: 1;
  readonly scope: BridgeIdentityScope;
  readonly capturedAt: string;
  readonly verifiedAt: string;
  readonly provenance: BridgeIdentityProvenance;
  readonly completeness: BridgeIdentityCompleteness;
  readonly outcomes: readonly BridgeArtistResolutionOutcome[];
  readonly targetArtists: readonly BridgeTargetArtist[];
}
```

`targetArtists` is created by `resolveArtistIdentities()` from the same complete validated input as
`outcomes`. It is not appended later by the action. It must have unique positive Lidarr IDs,
terminal-safe bounded titles, canonical nullable MBIDs, deterministic ordering, and an exact count
match with `completeness.targetArtistCount`. Existing record and payload byte caps still apply.

### Reconciliation report v1

The pure result uses schema identifier `rfmedia.plex-lidarr-reconciliation.v1` and readonly frozen
values.

```ts
interface PlexLidarrReconciliationResultV1 {
  readonly schema: "rfmedia.plex-lidarr-reconciliation.v1";
  readonly scope: BridgeIdentityScope;
  readonly provenance: BridgeIdentityProvenance;
  readonly capturedAt: string;
  readonly verifiedAt: string;
  readonly completeness: BridgeIdentityCompleteness;
  readonly summary: ReconciliationSummary;
  readonly matchedExact: readonly ReconciliationItem[];
  readonly reviewSuggested: readonly ReconciliationItem[];
  readonly reviewAmbiguous: readonly ReconciliationItem[];
  readonly plexOnly: readonly ReconciliationItem[];
  readonly lidarrOnly: readonly ReconciliationItem[];
  readonly conflicts: readonly ReconciliationItem[];
  readonly unavailable: readonly ReconciliationItem[];
  readonly duplicates: readonly ReconciliationDuplicate[];
  readonly suggestions: readonly ReconciliationSuggestion[];
}
```

Each `ReconciliationItem` carries a stable category, reason, method, source identity when present,
target identity when present, and nullable `score`/`runnerUpMargin`. It never contains provider wire
records, raw GUID URLs, credentials, paths, response bodies, or arbitrary error text.

Evidence categories are:

| Category                 | Meaning                                                  | Authoritative |
| ------------------------ | -------------------------------------------------------- | ------------- |
| `authoritative`          | Unique exact MBID match                                  | Yes           |
| `review-normalized-name` | Unique normalized-name suggestion                        | No            |
| `review-fuzzy-name`      | Threshold-and-margin-qualified fuzzy suggestion          | No            |
| `ambiguous`              | Multiple or insufficiently separated candidates          | No            |
| `unmatched`              | Complete evidence produced no qualifying candidate       | No            |
| `conflict`               | Malformed, duplicate, or contradictory identity evidence | No            |
| `unavailable`            | Required compatible evidence cannot be trusted           | No            |

Duplicate codes are limited to evidence the bridge owns:

- `duplicate-source-mbid`
- `duplicate-target-mbid`
- `source-normalized-name-collision`
- `target-normalized-name-collision`
- `contradictory-name-mbid`

Duplicate members contain bounded provider-local IDs, safe titles, and canonical MBIDs when
available. They are deterministically ordered and capped by existing bridge resource limits.

Suggestion records use stable action codes such as `refresh-source-metadata`,
`correct-target-metadata`, `inspect-target`, `run-duplicate-audit`, and
`review-sealed-plan`. A machine suggestion carries an argv array, not executable shell text. No
suggestion emits `rfmedia lidarr apply`; it may point to a compatible existing plan producer only
when its prerequisites and exact identity evidence are present.

## Live and Offline Data Flow

### Live mode

```text
command validation
  -> one cancellable local-only action
  -> resolve canonical origins and required provider facades
  -> acquire Plex instance ID
  -> page one explicit Plex music library to completion
  -> list complete Lidarr artist catalog
  -> resolveArtistIdentities()
  -> validate immutable snapshot v2
  -> atomically replace same-scope cache generation
  -> project pure reconciliation result
  -> render one selected output format
```

Plex and Lidarr reads may overlap, but no SQLite transaction remains open during provider I/O.
Plex pages are sequential and must prove positive offset progress, one stable library ID, unique
source IDs, bounded totals, and terminal completion. Lidarr uses
`LidarrClientApi.listArtists(signal)` without applying mutation `maxBatch` limits.

The cache replacement occurs only after both catalogs and the resolver snapshot are complete.
Failed validation, cancellation, provider failure, or persistence failure retains the previous
generation and returns an operational failure.

### Offline mode

```text
command validation
  -> credential-free canonical origin resolution
  -> open tracking database read-only
  -> select zero/one/many compatible v2 scopes
  -> require exactly one scope
  -> strictly project snapshot v2
  -> project the same pure reconciliation result
  -> render stale provenance and age
```

Offline mode constructs no Plex adapter, Lidarr client, scheduler task, or provider health check. It
performs no DNS/network request, migration, cache refresh, database write, plan creation, or
provider mutation. Database closure occurs in `finally`.

## Cache v2 and Scope Selection

The cache remains keyed by:

```text
(plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind)
```

Offline selection is filtering, not a weakened cache identity:

1. Resolve credential-free canonical Plex and Lidarr origins from flags or configuration.
2. Query compatible v2 metadata by both origins and `entity_kind = artist`.
3. If `--plex-library-id <id>` is supplied, filter by the stable section ID.
4. Accept exactly one compatible full scope.
5. Return `missing-compatible-snapshot` for zero matches.
6. Return `ambiguous-snapshot-scope` for multiple matches and disclose only bounded safe library
   IDs, capture times, and ages.

The command never chooses the newest row across multiple machines or libraries. Online mode
requires an explicit Plex music library selector from `--plex-library` or configuration and stores
the resolved stable section ID.

Offline origin resolution must not require Plex or Lidarr credentials or eager expansion of those
credential values. Canonicalization must reuse one narrow credential-free URL helper rather than
copying transport security rules into command or cache code.

Snapshot v1 rows are retained but rejected as `incompatible-snapshot` with guidance to run one
online refresh. There is no partial in-memory upgrade because the missing target catalog cannot be
reconstructed truthfully.

## CLI/UX/JSON/YAML/CSV and Exit Behavior

### Command grammar

```text
rfmedia lidarr reconcile [options]

--plex-library <name>       Select one Plex music library for a live run
--plex-library-id <id>      Disambiguate a cached stable library scope offline
--offline                   Use cached evidence only; perform zero provider I/O
--duplicates                Include bridge-owned duplicate identity findings
--plex-url <url>            Override the Plex origin
--plex-token <token>        Override the Plex token for a live run
--lidarr-url <url>          Override the Lidarr origin
--lidarr-api-key <key>      Override the Lidarr API key for a live run
-v, --verbose               Show all human detail rows
```

Global output options retain their existing behavior. There is no `--apply`, `--yes`,
`--allow-stale`, match-threshold, or fail-on-gap option.

`--offline` rejects `--plex-token` and `--lidarr-api-key` as contradictory. `--plex-library-id` is
an offline stable-scope discriminator; `--plex-library` selects the live library. Validation occurs
inside the command action handler's shared failure boundary before lazy action import.

### Human output

Human output goes to stderr. It shows:

- mode, scope, capture/verification time, and cache age when offline;
- summary counts with an explicit note that review suggestions remain in both directional gaps;
- bounded sections for exact matches, Plex-only, Lidarr-only, review suggestions, ambiguity,
  conflicts, unavailable evidence, and optional duplicates;
- inert remediation guidance;
- execution metadata.

Default detail is bounded; `--verbose` removes presentation truncation but not acquisition or
domain safety caps. State never depends on color alone.

### JSON and YAML

JSON and YAML write exactly one prose-free stdout document:

```json
{
  "command": "lidarr-reconcile",
  "result": {
    "schema": "rfmedia.plex-lidarr-reconciliation.v1"
  }
}
```

Both formats expose the complete result, provenance, summary, stable codes, and execution metadata.

### CSV

CSV emits a fixed flat schema with `command` and `rowType`. Row order is:

1. one `summary` row;
2. reconciliation `item` rows in stable category order;
3. optional `duplicate` rows;
4. `suggestion` rows.

Columns include category, reason, method, source ID/title/MBID, target ID/title/MBID, score, margin,
duplicate code, suggestion code/argv, scope IDs, provenance, capture/verification time, age, and
summary counts. Nested candidate/member/argv arrays may be JSON-encoded cells, but identifiers and
primary classification remain first-class columns.

### Exit behavior

- Exit `0`: complete report, including any gaps, suggestions, ambiguity, conflicts, or duplicates.
- Exit `1`: invalid options, missing capability, provider/configuration failure, incomplete
  evidence, cache persistence failure, missing/ambiguous/incompatible/corrupt offline scope, or
  cancellation.
- No implicit CI policy maps findings to failure. A future `--fail-on` requires a separate stable
  severity contract.
- Failures use the existing Lidarr human or machine envelope, redact both provider credentials,
  and set `process.exitCode`; they do not call `process.exit()`.

## Audit Integration

The reconciliation engine is the sole future source for Plex-Lidarr alignment findings.
`lidarr audit` must never add a second title matcher or derive reverse gaps independently.

For #208 delivery:

- `rfmedia lidarr reconcile` is the primary acceptance surface.
- The reserved `plex-alignment` audit detail must stop claiming the identity foundation is absent;
  it should direct operators to `rfmedia lidarr reconcile`.
- Full audit activation may follow under its existing audit roadmap scope after the shared report
  contract is stable.

When activated later, audit gathers provider evidence once, calls the same pure projector, maps
stable reconciliation codes to audit findings, and preserves audit network budgets and skipped-slot
semantics.

## Safety/Security/Cancellation

- Preserve the single authenticated Plex transport and handwritten Lidarr facade boundaries.
- Bridge code cannot import private Plex modules, generated Lidarr modules, Commander, SQL,
  filesystem, logger, prompt, environment, or `process`.
- Origins are canonical and credential-free. Tokens and API keys never enter scope keys, cache
  payloads, output, logs, plan checksums, suggestions, or thrown messages.
- Cross-origin Plex overrides retain the existing explicit replacement-token guard in live mode.
- Cached JSON and provider responses begin as `unknown` and are strictly projected with byte,
  cardinality, safe-integer, canonical-ID, timestamp, and terminal-control bounds.
- Untrusted titles are terminal-safe before persistence and rendering.
- Cache rows never authorize mutation. A future action must perform a fresh exact-ID/MBID and
  expected-state read before sealed apply.
- The action accepts one `AbortSignal` and propagates it to scheduling, Plex instance lookup, every
  Plex page, and every Lidarr call.
- Caller cancellation is terminal: no retry, fallback, partial report, snapshot replacement, plan
  artifact, prompt, or mutation.
- Cache replacement is a short atomic transaction after validation; readers never observe mixed
  generations.
- Output ordering and reason codes are deterministic so retries and offline replay are auditable.

## Critical Test Matrix

Tests must prove distinct contracts without duplicating every format/provider permutation.

| Boundary             | Critical cases                                                                                                                                                               | Required evidence                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Snapshot v2 mapping  | complete target retention; empty sides; duplicate/invalid target IDs; deterministic order; caps; immutability                                                                | Reverse catalog is complete and validated once                  |
| Cache v2             | v2 round-trip; v1 incompatibility; zero/one/many scopes; library-ID filter; cross-origin/machine isolation; corrupt/oversized payload; old generation retained after failure | Offline scope is truthful and atomic                            |
| Pure reconciliation  | exact match; suggested pair remains in both gaps; ambiguity; conflict; unavailable; empty sides; target consumed once; input permutations; summary/detail parity             | Bidirectional set arithmetic and evidence categories are stable |
| Duplicate enrichment | opt-out empty; source/target MBID collisions; normalized collision; deterministic cap                                                                                        | Optional findings do not change primary classification          |
| Live action          | complete Plex paging; stable library scope; one complete Lidarr list; missing identity capability; stalled/partial reads; bounds; cache after validation only                | No partial report or cache replacement                          |
| Offline action       | exact hit; missing/ambiguous/incompatible/corrupt scope; age provenance; read-only close in `finally`                                                                        | Zero provider/client/scheduler construction and zero writes     |
| Cancellation         | before start; during Plex page; during Lidarr read; before cache replacement                                                                                                 | Signal propagates and leaves prior generation intact            |
| Command              | exact option forwarding; contradictory flags; lazy import; human bounded/verbose; JSON/YAML envelope; CSV columns/order; credential redaction                                | Formats and exit behavior match the contract                    |
| Shell completion     | exact command/options/value-taking behavior in Bash/Zsh/Fish; static generation                                                                                              | No config, database, client, or network side effect             |
| Architecture         | no direct Plex/generated imports; one Fetch owner; mutation ownership unchanged                                                                                              | Existing architectural boundaries remain enforced               |

Run focused tests for mapping, cache, reconcile, action, command, and completions; then run the
rfmedia package typecheck/build/full suite, architecture checks, Lidarr codegen drift checks, and
repository gates. Build `@rfmedia/common` first in a fresh worktree when package resolution
requires it. Do not refresh the Lidarr OpenAPI snapshot.

## Shell Completion Contract

`reconcile` must appear in the exact Lidarr command tree for Bash, Zsh, and Fish. All three expose
the same leaf options:

```text
--plex-library
--plex-library-id
--offline
--duplicates
--lidarr-url
--lidarr-api-key
--plex-url
--plex-token
-v
--verbose
```

All six URL/token/library options that take values must be marked as value-taking in each shell.
Completion candidates are static. Generation must not load configuration, expand secrets, open the
tracking database, construct a provider client, or contact a network.

`templates.spec.ts` owns the shared expected option set and exact cross-shell parity assertions.
The pinned Lidarr hierarchy test must add `reconcile`.

## Documentation/ROADMAP

Update:

- `packages/rfmedia-cli/README.md` with the command synopsis and report-first safety statement.
- A focused feature guide under `packages/rfmedia-cli/docs/features/` covering live/offline
  workflows, scope selection, evidence categories, overlap of suggestions and gaps, duplicates,
  formats, exit behavior, and troubleshooting.
- Existing audit documentation so the reserved `plex-alignment` text points to reconciliation
  rather than claiming #207/#208 identity support is unavailable.
- `ROADMAP.md` in the merging PR with shipped-at-merge wording, verified after authoritative merge.
- `docs/roadmap-archive.md` with the shipped contract and validation evidence.

Keep #209 and #221 open as dependent policy/mutation work. Documentation must distinguish the
allowed observational snapshot write from prohibited provider mutation and must not advertise
`--apply`.

## Architecture Blueprint

### Files to Create

| File                                                               | Purpose                                                        | Priority |
| ------------------------------------------------------------------ | -------------------------------------------------------------- | -------- |
| `packages/rfmedia-cli/src/lib/bridge/reconcile.ts`                 | Pure bidirectional classification, duplicates, and suggestions | P0       |
| `packages/rfmedia-cli/src/lib/bridge/reconcile.test.ts`            | Pure contract matrix                                           | P0       |
| `packages/rfmedia-cli/src/actions/lidarr/reconcile.ts`             | Live/offline orchestration and lifecycle                       | P0       |
| `packages/rfmedia-cli/src/actions/lidarr/reconcile.test.ts`        | Acquisition, cache, offline, and cancellation tests            | P0       |
| `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts`            | Leaf command and all presenters                                | P0       |
| `packages/rfmedia-cli/src/commands/lidarr-reconcile.test.ts`       | Grammar, formats, failures, and redaction tests                | P0       |
| `packages/rfmedia-cli/docs/features/plex-lidarr-reconciliation.md` | User-facing contract and examples                              | P1       |

### Files to Modify

| File                                                                | Changes                                                            | Priority |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ | -------- |
| `packages/rfmedia-cli/src/types/bridge.ts`                          | Snapshot v2, target catalog, report/duplicate/suggestion contracts | P0       |
| `packages/rfmedia-cli/src/lib/bridge/mapping.ts`                    | Build and validate complete target projection                      | P0       |
| `packages/rfmedia-cli/src/lib/bridge/cache.ts`                      | Strict v2 projection and compatible-scope lookup                   | P0       |
| `packages/rfmedia-cli/src/lib/adapters/index.ts`                    | Credential-free canonical Plex origin seam                         | P0       |
| `packages/rfmedia-cli/src/lib/lidarr/index.ts`                      | Credential-free canonical Lidarr origin seam                       | P0       |
| `packages/rfmedia-cli/src/actions/lidarr/index.ts`                  | Export action contract                                             | P1       |
| `packages/rfmedia-cli/src/commands/lidarr.ts`                       | Register the lazy leaf and shared helpers                          | P1       |
| `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` | Exact static command/option parity                                 | P1       |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`  | Hierarchy, option, value, and side-effect contracts                | P1       |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`        | Extend fixtures only if new files are not already covered          | P1       |
| `packages/rfmedia-cli/README.md` and roadmap/audit docs             | Public behavior and shipped-state updates                          | P1       |

No SQL schema-version change is needed for payload-only snapshot v2. If implementation adds indexed
columns or constraints, schema SQL, migration, current/read-only version constants, and database
tests must advance together.

## Build Sequence

1. Freeze snapshot-v2, reconciliation, duplicate, suggestion, scope-selection, and CLI contracts.
2. Implement Child A target projection, strict cache v2, credential-free origin normalization, and
   compatible-scope tests.
3. Implement the pure reconciliation engine and its focused set-arithmetic matrix.
4. Implement live/offline action orchestration, cancellation, and cache lifecycle.
5. Implement the leaf command, human and machine presenters, and registration.
6. Update Bash, Zsh, and Fish together and lock parity.
7. Update feature, README, audit handoff, and ROADMAP documentation.
8. Run focused, package, architecture, codegen, completion, and repository validation.

## Acceptance Criteria

- [ ] `rfmedia lidarr reconcile` is registered and documented.
- [ ] The live path enumerates one explicit Plex music library and the full Lidarr artist catalog.
- [ ] Unique one-to-one MBID joins are the only authoritative matches.
- [ ] Normalized/fuzzy matches remain review-only and expose score/margin as evidence.
- [ ] Complete deterministic `plex_only` and `lidarr_only` sets are reported.
- [ ] Suggested pairs remain in both directional gaps until reviewed.
- [ ] Ambiguous, conflict, unmatched, and unavailable evidence remains distinguishable.
- [ ] `--duplicates` adds bounded bridge-owned findings without changing primary classifications.
- [ ] Suggestions are inert and point only to metadata review, duplicate audit, or compatible sealed
      planning workflows.
- [ ] Snapshot v2 retains and strictly validates the complete minimal Lidarr target catalog.
- [ ] Snapshot v1 is rejected offline with refresh guidance.
- [ ] Offline scope selection accepts exactly one compatible full scope and never guesses.
- [ ] `--offline` performs zero provider/client/scheduler construction, network I/O, migration, or
      write.
- [ ] Offline provenance, capture/verification time, and age appear in every output format.
- [ ] A live snapshot replaces cache only after complete validation; failure preserves the prior
      generation.
- [ ] Human output uses stderr; JSON/YAML/CSV produce one prose-free stdout document.
- [ ] Gaps, suggestions, ambiguity, conflicts, and duplicates exit 0; operational failures exit 1.
- [ ] Credentials, raw provider records, paths, and unsafe terminal text cannot reach cache or
      output.
- [ ] Cancellation reaches all provider calls and prevents fallback, partial output, and cache
      replacement.
- [ ] No `--apply`, prompt, plan artifact, provider mutation, new Fetch owner, runtime dependency,
      generated Lidarr edit, or MusicBrainz request is introduced.
- [ ] Bash, Zsh, and Fish expose the exact same command and options with static side-effect-free
      completion.
- [ ] Two tracking children exist and may close through one PR only with explicit dependency and
      per-child evidence.
- [ ] Focused, full-package, architecture, codegen, completion, and repository validation passes.
- [ ] ROADMAP completion records #208 only after authoritative merge; #209/#221 remain open.

## Risks/Rollback

| Risk                                      | Mitigation                                       | Rollback                                                                       |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Fuzzy evidence is mistaken for identity   | Stable review categories; no apply surface       | Remove presentation of name suggestions while retaining exact reports          |
| Reverse gap is incomplete offline         | Persist and validate complete target catalog     | Disable offline v2 reads; require live refresh                                 |
| Wrong cached library is selected          | Full scope identity and exact-one selection      | Require explicit `--plex-library-id` for all offline runs                      |
| Partial refresh replaces good evidence    | Validate before one atomic upsert                | Revert writer; retained prior rows remain usable                               |
| Snapshot v2 increases payload size        | Existing record/byte caps and minimal projection | Stop writing v2; v1 rows remain stored but cannot satisfy offline reverse gaps |
| Command surface drifts across shells      | One expected option set and parity tests         | Remove `reconcile` from all three templates with command rollback              |
| Audit duplicates reconciliation logic     | Shared pure engine only                          | Keep audit slot reserved and point to the command                              |
| Remediation text is treated as executable | Typed argv suggestions; no direct apply command  | Suppress suggestion rendering; core report remains intact                      |

Code rollback removes the command registration, action, projector, and completion entries. Snapshot
v2 uses the existing payload table, so rollback does not require destructive SQL. Existing v2 rows
remain inert and version-incompatible to older code; no provider state needs restoration because
v1 performs no provider mutation.

## Decisions

1. **Release shape:** artist-level report-first v1.
2. **Issue decomposition:** require two tracking children; permit one cohesive PR with explicit
   dependency order and separate evidence.
3. **Authority:** unique exact artist MBID only.
4. **Name evidence:** normalized/fuzzy candidates remain review-only; scores are not confidence.
5. **Directional gaps:** suggestions remain in both `plex_only` and `lidarr_only`.
6. **Offline completeness:** snapshot v2 stores the complete minimal Lidarr target catalog.
7. **Offline scope:** select exactly one compatible full scope by canonical origins and optional
   stable library ID; never newest-wins.
8. **Compatibility:** v1 cache documents are not upgraded or reinterpreted.
9. **Persistence:** complete live observational snapshots may be written atomically without apply;
   offline mode never writes.
10. **Mutation boundary:** no `--apply` in #208; mutations remain with #209/#221 or another focused
    sealed plan/apply issue.
11. **Duplicates:** opt-in bridge identity evidence only; deep Lidarr duplicates remain in audit.
12. **Audit:** later integration must reuse the same pure engine; #208 updates stale handoff text.
13. **Output:** deterministic human/JSON/YAML/CSV parity; report findings do not fail the command.
14. **Dependencies:** no new runtime dependency, provider endpoint, generated client change, or
    MusicBrainz network access.
