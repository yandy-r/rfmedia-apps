# Architecture Analysis: Plex-Lidarr Reconciliation

## Executive Summary

Issue #208 should be implemented as an artist-level, report-first consumer of the identity
foundation shipped by #207. The public entry point is `rfmedia lidarr reconcile`; a command module
parses and presents, an action module owns online/offline orchestration, and a pure bridge module
turns one complete identity snapshot into deterministic bidirectional gap and match-review
evidence. Provider wire types, credentials, generated Lidarr types, SQLite rows, prompts, and output
formatting must not cross into the pure bridge layer.

Two prerequisite gaps exist in the shipped foundation and are required work for #208:

1. `BridgeArtistIdentitySnapshot` stores one outcome per Plex artist but not the complete Lidarr
   target catalog. A live report can retain the original `listArtists()` result in memory, but an
   offline snapshot cannot reconstruct the complete `lidarr_only` set. Snapshot v2 must retain a
   bounded minimal target-artist catalog, or an equivalent complete reverse-index projection.
2. `readBridgeIdentitySnapshot()` requires the exact Plex origin, machine ID, library ID, Lidarr
   origin, and entity kind. Offline mode cannot discover the machine/library IDs without contacting
   Plex. The cache owner therefore needs a token-free compatible-scope lookup by canonical origins
   and optional stable library ID, with an explicit ambiguity failure when more than one scope
   matches.

The acceptance boundary should be deliberately narrower than the aspirational research mock-up:

- Required: complete artist-level `plex_only`, `lidarr_only`, authoritative exact matches,
  review-only name suggestions, ambiguous/conflict/unavailable categories, deterministic human and
  machine reports, explicit `--offline`, cached-snapshot age/scope provenance, and optional
  duplicate findings with non-mutating resolution suggestions.
- Required: online runs replace the complete observational snapshot only after both provider
  enumerations and resolution succeed. Offline runs perform zero provider/client construction and
  zero writes.
- Required: no name/fuzzy score is described as a probability. `score` and runner-up margin are
  evidence; only a unique one-to-one MBID join is an authoritative match.
- Out of scope: album/track reconciliation, play counts, ratings, quality mismatch, stale
  monitoring repair, automatic add/delete/merge/re-tag, continuous reconciliation, and policy
  evaluation (#209/#221 own downstream policy).
- Out of scope: applying provider mutations from cached evidence. Guided remediation is emitted as
  suggestions or existing plan-command handoffs. Any future executable remediation must use an
  explicit apply flag, a fresh provider read, exact-identity revalidation, existing sealed
  plan/apply authorization, and its own focused issue.

No child issues are required to complete this report-first #208 slice. The snapshot-v2 and
offline-scope work are not independent features; they are acceptance prerequisites for truthful
bidirectional offline reporting and should remain in #208. Create child/follow-up issues only if
the product decision expands #208 to executable remediation or to activating the older
`lidarr audit plex-alignment` surface in the same release. Those additions are separable and should
not block the named `reconcile` command.

## Architecture Context

### Existing boundaries

The current repository already supplies most of the hard identity work:

- `MediaServerAdapter.identity` provides a provider-neutral, bounded Plex instance ID and paged
  artist identities with MusicBrainz evidence.
- `LidarrClientApi.listArtists()` supplies the complete projected Lidarr artist catalog through the
  handwritten facade and hardened transport.
- `resolveArtistIdentities()` enforces complete input, unique exact MBID precedence, suggestion-only
  normalized/fuzzy names, deterministic ranking, resource bounds, and immutable outcomes.
- `bridge_identity_snapshots` plus `cache.ts` provide exact-scope, strict, atomic snapshot
  replacement and offline provenance.
- `rfmedia lidarr` already has command/action separation, lazy action loading, scheduler metadata,
  machine/human output separation, stable failure envelopes, and Bash/Zsh/Fish parity tests.

The public command should compose these seams rather than expose a second Plex client, a handwritten
Lidarr endpoint, or a new generic synchronization framework.

### Required control flow

```text
rfmedia lidarr reconcile
        |
        v
commands/lidarr-reconcile.ts
  - validate mode, library/scope, duplicate and output options
  - no provider, database, or matching work
        |
        v
actions/lidarr/reconcile.ts
  +-- online -----------------------------------------------+
  |  resolve safe origins + required adapter/client         |
  |  acquire stable Plex instance ID                        |
  |  enumerate one Plex music library to completion         |
  |  list the complete Lidarr artist catalog                |
  |  resolveArtistIdentities()                              |
  |  atomically persist a complete snapshot v2              |
  +---------------------------------------------------------+
  +-- offline ----------------------------------------------+
  |  normalize origins without requiring tokens             |
  |  resolve exactly one compatible cached scope            |
  |  reject missing, ambiguous, corrupt, or incompatible     |
  |  read snapshot; construct no adapter/client/scheduler    |
  +---------------------------------------------------------+
        |
        v
lib/bridge/reconcile.ts
  - pure projection into exact matches, review candidates,
    plex_only, lidarr_only, conflicts/unavailable, duplicates
  - stable ordering, summary, remediation suggestions
        |
        v
command presenter
  - human report on stderr
  - JSON/YAML envelope or flat per-artist CSV rows on stdout
  - gaps are report data, not operational failures
```

Online acquisition may run Plex and Lidarr reads concurrently, but the cache write must occur only
after both complete successfully and the resolver returns a complete snapshot. A transport failure
must retain the previous cache generation and fail the online command; it must never silently fall
back to stale evidence. The operator explicitly chooses `--offline`.

### Snapshot v2 and reverse-gap completeness

The current v1 snapshot contains:

- scope and version/provenance/completeness metadata;
- one resolution outcome per Plex artist;
- resolved targets or at most five name candidates attached to individual outcomes;
- only a numeric `targetArtistCount` for the complete Lidarr side.

That is sufficient for forward Plex-to-Lidarr identity review but not for reverse set difference.
For example, an empty Plex library and a 1,000-artist Lidarr library produces zero outcomes and only
the number `1000`; no offline code can name or identify the 1,000 `lidarr_only` artists.

Extend the stored document with an immutable, deterministically sorted minimal target catalog:

```ts
interface BridgeTargetArtist {
  readonly lidarrId: number;
  readonly title: string;
  readonly artistMbid: string | null;
}

interface BridgeArtistIdentitySnapshotV2 {
  readonly snapshotVersion: 2;
  // existing version, scope, provenance, completeness, and outcomes
  readonly targetArtists: readonly BridgeTargetArtist[];
}
```

The catalog must be produced by the resolver from the same validated complete input, not appended
by the action after resolution. Validate count equality, unique positive Lidarr IDs, bounded safe
titles, canonical nullable MBIDs, deterministic order, and byte/record caps in both resolver and
cache projection. Bump `BRIDGE_IDENTITY_SNAPSHOT_VERSION`; the SQL table shape can remain schema
version 11 because `payload_json` and existing version columns already model document evolution.
Old v1 rows become explicitly incompatible offline evidence until an online refresh writes v2.
Do not reinterpret or partially upgrade them.

### Report semantics

The pure reconciliation result should be versioned independently, for example
`rfmedia.plex-lidarr-reconciliation.v1`, and use stable codes rather than prose-derived
classification.

Use authoritative exact mappings for set arithmetic:

- `matched_exact`: unique one-to-one MBID resolutions only.
- `review_suggested`: normalized/fuzzy name candidates with score and margin; never automatic.
- `review_ambiguous`: collisions or insufficient separation.
- `plex_only`: complete Plex artists with no authoritative target and no conflict. A suggested
  candidate remains visibly reviewable and must not silently disappear from forward-gap evidence.
- `lidarr_only`: every retained Lidarr target not consumed by an authoritative exact mapping.
- `conflict`: malformed, duplicate, or contradictory identity evidence.
- `unavailable`: cache/version/response evidence that prevents a truthful classification.

`plex_only` and `lidarr_only` are directional sets, while suggestions are cross-set evidence; a
suggested pair may therefore appear in both directional gaps until reviewed. This is safer and more
truthful than treating a fuzzy candidate as reconciled. The human report should explain that rule;
the machine result should carry stable category/reason/method fields.

Report “match-confidence categories” as evidence classes, not invented probabilities:

- `authoritative`: unique exact MBID;
- `review-normalized-name`: exact normalized-name suggestion;
- `review-fuzzy-name`: threshold-and-margin-qualified fuzzy suggestion;
- `ambiguous`, `conflict`, and `unmatched`.

Preserve the existing numeric `score` field name and its documented meaning. Do not rename it to
`confidence`, multiply it into a percentage, or allow a threshold flag to authorize a match.

### Offline scope selection

Offline selection must not require Plex or Lidarr credentials, health checks, adapter creation, or
scheduler preflight. Current canonical-origin normalizers are private to connection factories and
the public Lidarr origin resolver also requires an API key. Add/reuse a narrow credential-free
normalization seam rather than duplicating URL security logic in the command.

Recommended selection:

1. Require canonical Plex and Lidarr URLs from config or CLI overrides.
2. Query compatible snapshot scopes by `(plex_origin, lidarr_origin, entity_kind)`.
3. If a stable `--plex-library-id` is supplied, filter on it.
4. Accept exactly one compatible scope.
5. A zero match is `missing-compatible-snapshot`; multiple matches are a stable
   `ambiguous-snapshot-scope` operational failure listing only safe library IDs and ages.

Online mode should require a configured/overridden Plex library name or ID and persist the resolved
stable section ID. Do not guess among multiple music libraries. The cache owner remains the only
module that issues SQL against `bridge_identity_snapshots`.

### Duplicate detection and remediation boundary

Duplicate reporting is optional and non-mutating. Reuse existing resolver evidence:

- duplicate Plex MBIDs;
- duplicate Lidarr MBIDs;
- normalized-name collisions and contradictory exact-name/different-MBID evidence.

The existing `lidarr audit --check duplicate-identity` remains the owner of Lidarr-only path,
folded-name, and deep album duplicate checks. Reconcile should link to that command rather than copy
its private grouping logic or claim cross-provider file/fingerprint certainty it does not possess.

Resolution suggestions may recommend:

- refresh/correct MusicBrainz metadata;
- inspect an exact Lidarr artist;
- run the existing duplicate-identity audit;
- generate an existing sealed artist-add/delete/profile plan where its required exact evidence is
  available.

No merge, delete, add, re-tag, Plex scan, or Lidarr update runs inside v1 reconciliation. The online
snapshot replacement is observational cache durability, not provider mutation; document this
distinction because “all writes behind apply” otherwise conflicts with the required cache refresh.

### Audit integration

`lidarr audit` currently reserves `plex-alignment` with
`identity-mapping-unavailable`, and comments explicitly point at #207/#208. The new pure
reconciliation engine is the correct eventual evaluator seam. However, activating it also requires
changing audit gather planning, slot types, Plex identity acquisition, presentation tests, and
network budgets. It is not necessary to satisfy the live #208 issue text naming
`rfmedia lidarr reconcile`.

Keep command reconciliation as the primary acceptance path. If audit activation is included, it
must call the same pure engine and must not perform a second independent title matcher. Otherwise,
open a focused follow-up and update the stale reserved detail so it points to `lidarr reconcile`
rather than claiming the identity layer does not exist.

## Critical Files Reference

| File                                                                                                  | Architectural role and required change                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/types/bridge.ts`                                                            | Extend the versioned snapshot with the complete minimal Lidarr target catalog; define stable reconciliation result/category/duplicate/remediation contracts here or in a focused `types/bridge-reconcile.ts`.           |
| `packages/rfmedia-cli/src/lib/bridge/mapping.ts`                                                      | Continue owning canonical target projection and complete snapshot construction. Snapshot-v2 catalog must be derived and validated here so live and cached reports use identical evidence.                               |
| `packages/rfmedia-cli/src/lib/bridge/mapping.test.ts`                                                 | Prove complete reverse catalog retention, empty-side cases, unique IDs, canonical MBIDs, deterministic order, immutability, and resource bounds.                                                                        |
| `packages/rfmedia-cli/src/lib/bridge/cache.ts`                                                        | Sole SQL owner. Add compatible-scope lookup/listing, strict snapshot-v2 projection, ambiguity-safe metadata, and retain atomic same-scope replacement.                                                                  |
| `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`                                                   | Cover v1 incompatibility, v2 round-trip, unique/multiple offline scopes, corrupt catalogs, origin/library isolation, no-write reads, and old-generation retention on failed replacement.                                |
| `packages/rfmedia-cli/src/lib/bridge/reconcile.ts`                                                    | **Create.** Pure bidirectional set projection, evidence classes, duplicate findings, stable ordering/summary, and inert remediation suggestions. No I/O, logger, prompt, process, SQL, or provider imports.             |
| `packages/rfmedia-cli/src/lib/bridge/reconcile.test.ts`                                               | **Create.** Exact/review/gap/conflict matrices, target reuse, empty libraries, suggested-pair dual gaps, duplicate opt-in, ordering, immutability, and no-secret/sanitized output contracts.                            |
| `packages/rfmedia-cli/src/actions/lidarr/reconcile.ts`                                                | **Create.** Own flag-independent online/offline acquisition, paging to completion, scheduler/adapter/database lifecycle, atomic persistence, cancellation, and pure-engine invocation.                                  |
| `packages/rfmedia-cli/src/actions/lidarr/reconcile.test.ts`                                           | **Create.** Prove online read order/completeness/cache replacement, offline zero client/network/write behavior, partial-read failure retention, paging progress, scope ambiguity, cache errors, and execution metadata. |
| `packages/rfmedia-cli/src/actions/lidarr/index.ts`                                                    | Export the new action/result types consistently with other Lidarr leaves if the command uses the action barrel. Keep lazy loading intact.                                                                               |
| `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts`                                               | **Create.** Commander leaf, validation, human presenter, JSON/YAML envelope, flat CSV rows, failure redaction, and exit behavior. Keep `commands/lidarr.ts` from growing another large presenter.                       |
| `packages/rfmedia-cli/src/commands/lidarr-reconcile.test.ts`                                          | **Create.** Exact flags, conflicts, forwarding, human/machine parity, CSV shape, no-prose stdout, redaction, gaps-as-success, and lazy/no-side-effect help.                                                             |
| `packages/rfmedia-cli/src/commands/lidarr.ts`                                                         | Register the reconcile factory in documented order, add its success command type if shared helpers require it, and keep failure formatting consistent.                                                                  |
| `packages/rfmedia-cli/src/commands/lidarr.test.ts`                                                    | Add `reconcile` to the exact hierarchy and prove parent/global option behavior remains stable.                                                                                                                          |
| `packages/rfmedia-cli/src/lib/adapters/index.ts`                                                      | Expose a narrow credential-free canonical Plex-origin resolver or safe resolved scope helper. Do not expose tokens, private Plex configuration, or machine identity as adapter properties.                              |
| `packages/rfmedia-cli/src/lib/lidarr/index.ts`                                                        | Reuse/refactor canonical origin validation so offline scope resolution does not require an API key; preserve existing required-client behavior.                                                                         |
| `packages/rfmedia-cli/src/types/media-server.ts`                                                      | Reuse the optional identity capability unchanged unless cancellation/scope requirements prove a missing provider-neutral field. Do not add reconciliation to the adapter contract.                                      |
| `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`                                              | Existing bounded page primitive. The action owns complete-page iteration and must verify forward progress and one stable library ID.                                                                                    |
| `packages/rfmedia-cli/src/lib/lidarr/client.ts`                                                       | Existing `listArtists()` facade is sufficient. No generated endpoint or handwritten `/api/v1/` path is needed.                                                                                                          |
| `packages/rfmedia-cli/src/lib/db.ts`                                                                  | Reuse writable initialization online and read-only behavior where feasible offline. No schema-version bump is required solely for payload snapshot v2.                                                                  |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`                                          | Existing architecture gate must continue rejecting bridge imports of private Plex/generated Lidarr modules and extra Fetch owners. Add reconcile fixtures only if current coverage does not traverse the new files.     |
| `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`                                              | Add the new leaf and exact static flags. Completion generation must not open config/database or contact providers.                                                                                                      |
| `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`                                               | Mirror the same leaf/options/value handling.                                                                                                                                                                            |
| `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`                                              | Mirror the same leaf/options/value handling.                                                                                                                                                                            |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`                                    | Extend the exact Lidarr command tree and assert Bash/Zsh/Fish reconcile option parity and static side-effect freedom.                                                                                                   |
| `packages/rfmedia-cli/src/actions/lidarr/audit.ts` and `packages/rfmedia-cli/src/lib/lidarr/audit.ts` | Optional follow-up/integration lane only. Replace the reserved slot with the shared result if audit activation is explicitly included; never create a second matcher.                                                   |
| `packages/rfmedia-cli/src/types/lidarr-audit.ts`                                                      | Optional audit activation: widen the `plexIdentity` slot and descriptor finding codes. Otherwise update only stale future-facing prose if needed.                                                                       |
| `packages/rfmedia-cli/README.md` and `packages/rfmedia-cli/docs/features/`                            | Document scope selection, authoritative versus review evidence, offline age, duplicates, machine schemas, no-mutation default, and explicit exclusions.                                                                 |
| `ROADMAP.md` and `docs/roadmap-archive.md`                                                            | After authoritative merge, mark only #208 shipped and retain #209/#221 as dependent Layer 3 work.                                                                                                                       |

## Cross-Cutting Concerns

### Completeness and fail-closed evidence

- Both provider enumerations must be complete. Plex paging must enforce positive forward progress,
  stable library ID, bounded total records, no duplicate local IDs, and cancellation.
- A failed/partial live read is not an empty library and must not replace the prior snapshot.
- `lidarr_only` is derived from the complete retained target catalog, never from truncated outcome
  candidate lists or `targetArtistCount`.
- Empty Plex, empty Lidarr, and both-empty libraries are valid when the respective enumerations
  completed successfully.
- A target can be consumed by at most one authoritative exact match. Duplicate MBID evidence is a
  conflict, never first-row-wins.

### Safety, privacy, and stale evidence

- Cache scope uses credential-free canonical origins plus opaque machine/library IDs. Never persist
  tokens, full request URLs, raw GUIDs, paths, provider response bodies, or unbounded names.
- Offline age and captured/verified timestamps are visible in every format. Offline evidence is
  stale by definition; do not label it fresh because it passed strict projection.
- Cache data is report evidence, not mutation authorization. Suggestions must not embed secrets or
  unsafe shell text; quote bounded identifiers when emitting command examples.
- Preserve the cross-origin Plex override guard. A URL override without a replacement token must
  not cause a configured token to cross origins during online mode.
- Bound and sanitize errors before human or machine output; API keys supplied by flags are
  redaction values.

### Output and exit behavior

- Human output goes to stderr. JSON/YAML/CSV produces exactly one prose-free stdout document.
- JSON/YAML use a versioned `{ command: "lidarr-reconcile", result }` envelope. CSV should emit one
  flat row per reconciliation item with category, source/target IDs, method, reason, score, margin,
  duplicate code, and provenance fields; do not serialize nested arbitrary JSON cells as the sole
  CSV contract.
- Gaps, review suggestions, and duplicate findings are successful analytical results and return
  exit code 0. Missing/incompatible/ambiguous offline scope, incomplete online evidence, provider
  failure, or cache durability failure is operational failure and returns 1.
- Do not add an implicit CI policy such as nonzero-on-gap. A future `--fail-on` would require its
  own stable severity contract.
- Ordering must be stable independent of provider response order: category order first, then
  normalized safe title, provider ID, and target ID.

### Compatibility and architecture enforcement

- Preserve TypeScript ESM/NodeNext `.js` imports, Node.js 22+, frozen readonly domain values, and
  action/command separation.
- Bridge code consumes only provider-neutral `MediaArtistIdentity`, projected `LidarrArtist`, and
  bridge contracts. It cannot import private Plex modules, generated Lidarr code, or own Fetch.
- Do not widen ordinary Plex query DTOs or change existing public MCP/command JSON shapes.
- Snapshot document v2 does not require SQL schema v12. If implementation changes table columns or
  constraints, then `CURRENT_SCHEMA_VERSION`, the exact read-only version, schema SQL, migration,
  and database tests must advance together.
- A public command change requires Bash, Zsh, and Fish templates plus exact parity tests.

### Performance and scheduling

- Keep the existing 10,000-record and one-million-comparison bounds unless evidence justifies a
  versioned policy change.
- Plex identity pages are sequential and response-driven. Lidarr artist enumeration is one
  unpaged local read by established contract and must not inherit mutation `maxBatch` limits.
- Provider reads may overlap, but no SQLite transaction should remain open during network I/O.
- Build and validate the complete snapshot in memory, then perform one short atomic replacement.
- Offline lookup is indexed/bounded SQL plus pure projection and performs no scheduler work.

## Parallelization Opportunities

Parallel work is safe after the snapshot-v2 and reconciliation-result contracts are frozen.

| Batch | Parallel lane              | Ownership                                                       | Dependency and collision note                                                                      |
| ----- | -------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1     | Snapshot/domain contract   | `types/bridge.ts`, `lib/bridge/mapping.ts`, mapping tests       | Contract owner lands first; cache and pure report consume it.                                      |
| 1     | Pure reconciliation engine | new `lib/bridge/reconcile.ts` and tests                         | Can proceed from a frozen fixture contract without provider/database work.                         |
| 2     | Cache and offline scope    | `lib/bridge/cache.ts` and tests; credential-free origin helpers | Depends on snapshot v2; coordinate origin helper ownership with action lane.                       |
| 2     | Online action acquisition  | new action and tests                                            | Depends on snapshot v2 and pure engine; use injected clients/cache seams so tests remain isolated. |
| 3     | Command and presenters     | new command module/tests plus `commands/lidarr.ts` registration | Depends on final result/option contracts; do not edit the pure engine here.                        |
| 3     | Completion surface         | all three shell templates and parity tests                      | One owner must change all shells together after flags are final.                                   |
| 3     | Documentation              | README, feature guide, roadmap/archive                          | Depends on final names/output. Roadmap completion waits for authoritative merge.                   |
| 4     | Optional audit integration | audit action/types/evaluator/tests                              | Starts only after the shared engine is stable; separable follow-up if scope pressure appears.      |

The cache/offline lane and online action lane must not independently duplicate canonical URL
normalization. Command/presenter and completion lanes must share one exact option registry or
Commander-derived test expectation to prevent drift.

## Implementation Constraints

1. The release is artist-level only. Album, track, file-path, play-count, rating, quality-profile,
   and monitoring-state reconciliation are excluded.
2. Unique exact MBID is the only authoritative match. Normalized/fuzzy results remain review-only
   regardless of score or operator-selected threshold.
3. The report must expose complete directional sets. Candidate caps cannot be used to infer
   `lidarr_only`; retain and validate the complete minimal target catalog in snapshot v2.
4. Snapshot-v2 payload compatibility is explicit. Never cast or silently reinterpret v1 rows;
   offline tells the operator to refresh online.
5. Offline mode is strict: no adapter/client construction, credential requirement, health check,
   scheduler preflight, DNS/network request, cache refresh, migration, or write.
6. Online mode is network-first and all-or-nothing for durability. Only a complete validated
   snapshot replaces the same scope; a failure leaves the previous generation intact.
7. Online observational cache replacement is allowed without an apply flag. Provider state writes
   are not. Any future provider mutation requires an explicit apply flag, live identity/state
   revalidation, sealed plan/apply authorization, and independent tests.
8. Require an explicit Plex music library by config/flag online. Offline accepts exactly one
   compatible cached scope or a stable library-ID selector; it never guesses.
9. Preserve the full cache scope `(Plex origin, machine ID, library ID, Lidarr origin, artist)`.
   Origin-only lookup is selection, not permission to merge or overwrite scopes.
10. Duplicate detection is opt-in report enrichment. Suggestions are inert; cross-system merge,
    delete, re-tag, fingerprint, and filesystem claims are excluded.
11. Gaps and duplicates do not fail the command. Only inability to produce a truthful complete
    report is operational failure.
12. Human and machine formats must express the same categories, reasons, counts, provenance, and
    limitations. Color is never the only state signal.
13. The command/action/pure-library split is mandatory. The pure engine has no Commander, logger,
    process, prompt, database, filesystem, provider client, or environment dependency.
14. No new runtime dependency, MusicBrainz network client, Fetch owner, generated Lidarr endpoint,
    handwritten API path, daemon/watch loop, or generic reconciliation framework belongs in #208.
15. Update and test Bash, Zsh, and Fish together. Completion generation remains static and cannot
    load configuration, open SQLite, or contact providers.
16. Focused validation must include bridge mapping/cache/reconcile, action/command, completion
    parity, architecture, and codegen drift tests, followed by rfmedia typecheck/build/full suite and
    repository gates. Build `@rfmedia/common` first in a fresh worktree when required.
17. After source changes, run `graphify update .` per repository policy; the planning worktree has
    no existing graph, so this analysis used direct source inspection.
