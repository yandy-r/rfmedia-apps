# Task Structure Analysis: Issue #208 Plex-Lidarr Reconciliation

## Executive Summary

Implement #208 as two dependency-ordered children. Child A must first make the identity snapshot
truthful for offline bidirectional reporting by shipping snapshot v2, a complete minimal Lidarr
target catalog, credential-free canonical-origin helpers, and exact-one cached-scope selection.
Child B can then add the pure report engine, online/offline orchestration, CLI and output surfaces,
the still-reserved audit-slot correction, completion parity, and documentation. Provider mutations
are excluded: no reconcile apply flag, Plex/Lidarr write, plan generation, or policy evaluation
belongs here; those remain #209/#221.

Testing should be intentionally narrow. Use one parameterized contract matrix at the pure boundary,
one action suite for the online/offline orchestration invariants, one command suite for format and
failure behavior, and the existing hierarchy/completion parity gates. Do not repeat the full
classification matrix in cache, action, command, and shell tests.

## Recommended Phase Structure

### Phase 1: Child A — Snapshot v2 contract

Child A is a prerequisite and should merge before Child B begins integration work.

- **A1 — Freeze the snapshot-v2 domain contract**
  - **Depends on:** none.
  - **Owns:** `packages/rfmedia-cli/src/types/bridge.ts`,
    `packages/rfmedia-cli/src/types/index.ts`.
  - Bump `BRIDGE_IDENTITY_SNAPSHOT_VERSION` to `2` and add an immutable, bounded target projection
    containing only positive Lidarr ID, terminal-safe title, and canonical nullable artist MBID.
    Add the compatible-scope selector/result types needed by cache lookup without weakening the
    existing full `BridgeIdentityScope`.
  - Keep v1 explicitly incompatible; do not cast, migrate, or partially reinterpret old payloads.
    The payload-only version change does not require a SQL schema bump.

- **A2 — Build and validate the complete target catalog**
  - **Depends on:** A1.
  - **Owns:** `packages/rfmedia-cli/src/lib/bridge/mapping.ts`,
    `packages/rfmedia-cli/src/lib/bridge/mapping.test.ts`.
  - Have `resolveArtistIdentities()` derive `targetArtists` from the same complete validated input
    used for outcomes. Enforce count parity, unique positive IDs, canonical nullable MBIDs,
    deterministic ordering, record/byte bounds, and frozen output.
  - Add one compact table covering a non-candidate Lidarr artist, empty Plex with non-empty Lidarr,
    invalid/duplicate target IDs, ordering, and immutability. Existing resolver-policy cases remain
    the authority for exact/name matching and should not be duplicated.

- **A3a — Expose credential-free Plex-origin normalization**
  - **Depends on:** none; can run in parallel with A1.
  - **Owns:** `packages/rfmedia-cli/src/lib/adapters/index.ts`,
    `packages/rfmedia-cli/src/lib/adapters/index.test.ts` (create if a direct test seam is needed).
  - Extract/export a narrow helper that canonicalizes a configured or overridden Plex origin
    without requiring a token or constructing an adapter. Preserve rejection of credentials,
    paths, query strings, fragments, malformed URLs, and unsafe cross-origin override behavior.
  - Test only accepted canonical origin plus the security-significant rejection classes.

- **A3b — Expose credential-free Lidarr-origin normalization**
  - **Depends on:** none; can run in parallel with A1 and A3a.
  - **Owns:** `packages/rfmedia-cli/src/lib/lidarr/index.ts`,
    `packages/rfmedia-cli/src/lib/lidarr/index.test.ts`.
  - Separate canonical-origin resolution from API-key validation so offline selection can identify
    a cache namespace without constructing a client. Keep existing required-client and
    `resolveRequiredLidarrOrigin()` behavior compatible for online callers.
  - Extend the existing index test with only missing URL, malformed URL, canonical URL, and
    no-API-key offline cases.

### Phase 2: Child A — Exact offline scope selection and persistence

- **A4 — Persist and select compatible snapshot-v2 scopes**
  - **Depends on:** A1, A2.
  - **Owns:** `packages/rfmedia-cli/src/lib/bridge/cache.ts`,
    `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`.
  - Strictly project and round-trip the complete target catalog under the existing payload and
    cardinality caps. Add a bounded cache-owner API that selects candidates by canonical Plex
    origin, canonical Lidarr origin, and entity kind, optionally narrowed by stable Plex library
    ID; retain machine ID and the full exact scope in returned metadata.
  - Return zero/one/many candidates deterministically and make ambiguity a caller-visible state;
    never choose newest, merge libraries, or expose credentials/raw payloads. Exact snapshot reads
    must still use the full scope and offline reads must not write or migrate.
  - Extend the existing cache suite only for v2 round-trip, v1 incompatibility, zero/one/multiple
    scope selection, library narrowing/origin isolation, corrupt catalog rejection, and
    older-generation retention after a failed replacement.

- **A5 — Child A contract gate**
  - **Depends on:** A2, A3a, A3b, A4.
  - Run the focused mapping, cache, and origin-helper tests plus rfmedia typecheck and architecture
    checks. The child is complete only when a stored v2 snapshot can name every `lidarr_only`
    candidate offline and an origin-only selector either yields one exact full scope or fails
    explicitly.

### Phase 3: Child B — Pure reconciliation contract and engine

- **B1 — Define the versioned reconciliation result**
  - **Depends on:** Child A merged.
  - **Owns:** `packages/rfmedia-cli/src/types/bridge-reconcile.ts` (create),
    `packages/rfmedia-cli/src/types/index.ts`.
  - Define readonly stable contracts for summary, provenance, evidence categories, directional
    gaps, uncertainty, optional duplicate findings, and inert remediation suggestions. Use a
    result schema version independent of snapshot v2.
  - Exact unique MBID is the only authoritative match. Normalized/fuzzy names remain review
    evidence; scores are similarity evidence, never probability. Gaps, review items, and
    duplicates are successful report data.

- **B2 — Implement the pure bidirectional engine**
  - **Depends on:** B1.
  - **Owns:** `packages/rfmedia-cli/src/lib/bridge/reconcile.ts` (create),
    `packages/rfmedia-cli/src/lib/bridge/reconcile.test.ts` (create).
  - Project one complete snapshot into authoritative matches, review suggestions, ambiguous,
    conflict, unavailable, `plex_only`, and `lidarr_only` groups. Subtract only uniquely resolved
    exact target IDs; a suggested pair remains visible in both directional gaps until review.
  - Derive optional bounded duplicate groups from existing bridge evidence, preserve every input
    artist exactly once in its primary class, return deterministically sorted frozen values, and
    emit suggestions only—never executable mutations.
  - Use one parameterized matrix for exact/review/ambiguous/conflict/gap behavior, both-empty and
    one-side-empty inputs, duplicate opt-in, target reuse prevention, input permutation stability,
    count parity, and immutability.

### Phase 4: Child B — Online/offline action orchestration

- **B3 — Add the reconciliation action**
  - **Depends on:** A2, A3a, A3b, A4, B2.
  - **Owns:** `packages/rfmedia-cli/src/actions/lidarr/reconcile.ts` (create),
    `packages/rfmedia-cli/src/actions/lidarr/reconcile.test.ts` (create),
    `packages/rfmedia-cli/src/actions/lidarr/index.ts`.
  - Online: require the provider-neutral identity capability, resolve one explicit Plex music
    library, page Plex artists to completion with stable scope/forward progress, list all Lidarr
    artists through the handwritten facade, resolve identities, replace the cache only after full
    success, and invoke the pure engine. Forward cancellation everywhere and retain the previous
    generation on any partial/failing read.
  - Offline: normalize origins without credentials, open the tracking database read-only, apply
    the exact-one compatible-scope rule with optional library ID, strictly read the v2 snapshot,
    and invoke the same engine. Do not construct either provider, run health/preflight/scheduler
    work, fall back online, or write.
  - Keep the action suite to critical orchestration: one complete online/persist case, one
    paginated or stalled-scope failure retaining the prior cache, one exact offline hit proving
    zero provider construction/network/write, and one missing/ambiguous/incompatible offline
    failure. Pure classifications belong only in B2 tests.

### Phase 5: Child B — CLI, output, and registered surface

- **B4 — Add the leaf command and presenters**
  - **Depends on:** B3.
  - **Owns:** `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts` (create),
    `packages/rfmedia-cli/src/commands/lidarr-reconcile.test.ts` (create).
  - Implement the DI-factory leaf with lazy action loading. Freeze the final non-mutating option
    set: explicit offline mode, safe Plex/Lidarr overrides, stable library selection, optional
    duplicate detail, verbosity, and existing global formats; do not add apply/repair flags.
  - Human output goes to stderr. JSON/YAML emit one versioned
    `{ command: "lidarr-reconcile", result }` envelope; CSV uses fixed flat columns and a stable
    row discriminator. All formats expose category counts and live/cache age provenance.
  - Route failures through the existing Lidarr envelope with both secrets redacted. Gaps,
    suggestions, and duplicates exit successfully; incomplete evidence or unusable offline scope
    exits 1.
  - Test option validation/forwarding, one human success, one machine-envelope/CSV contract, and
    one redacted operational failure. Do not replay B2's category matrix here.

- **B5 — Register the command without widening the parent**
  - **Depends on:** B4.
  - **Owns:** `packages/rfmedia-cli/src/commands/lidarr.ts`,
    `packages/rfmedia-cli/src/commands/lidarr.test.ts`.
  - Register `reconcile` in the pinned Lidarr hierarchy and inject shared format/failure/execution
    helpers. Preserve leaf order, parent/global option behavior, lazy imports, and help with zero
    provider/config/database side effects.
  - Add only hierarchy and global-option integration assertions; leaf behavior remains in B4.

### Phase 6: Child B — Reserved audit contract and shell parity

- **B6 — Correct, but do not activate, the reserved `plex-alignment` slot**
  - **Depends on:** B4.
  - **Owns:** `packages/rfmedia-cli/src/actions/lidarr/audit.ts`,
    `packages/rfmedia-cli/src/lib/lidarr/audit.ts`,
    `packages/rfmedia-cli/src/lib/lidarr/audit.test.ts`.
  - Keep `plex-alignment` reserved with its existing stable skip shape; activation and its extra
    gather/network budget remain #211 work. Replace the now-false “no MusicBrainz join exists /
    #207/#208 have not landed” detail with guidance to run `rfmedia lidarr reconcile` and a clear
    statement that audit evaluation is still reserved.
  - Adjust the single reserved-slot contract assertion. Do not add a second matcher or feed network
    acquisition into audit.

- **B7 — Update all completion templates as one ownership unit**
  - **Depends on:** B4.
  - **Owns:** `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
    `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`,
    `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`.
  - Add `reconcile` and the exact finalized leaf flags/value-taking behavior identically in Bash,
    Zsh, and Fish. Completion remains static and must not import the action, load config, open
    SQLite, or contact providers.

- **B8 — Extend the cross-shell parity gate**
  - **Depends on:** B5, B7.
  - **Owns:** `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`.
  - Add one shared expected reconcile-option set and assert exact command, flag, value-argument,
    and side-effect parity across all three shells. Do not create separate per-shell behavioral
    suites.

### Phase 7: Child B — Documentation, roadmap, and release gate

- **B9 — Document the operator contract**
  - **Depends on:** B4, B6, B8.
  - **Owns:** `packages/rfmedia-cli/docs/features/plex-lidarr-reconciliation.md` (create),
    `packages/rfmedia-cli/README.md`,
    `packages/rfmedia-cli/docs/features/lidarr-audit.md`.
  - Document authoritative versus review-only evidence, directional-gap semantics, snapshot-v2
    refresh requirements, exact offline scope/ambiguity behavior, cache age/provenance, duplicate
    enrichment, human and machine schemas, exit behavior, and observational cache writes.
  - State explicit exclusions: no add/delete/merge/re-tag/scan/profile/ratings/policy mutation;
    downstream mutation and policy remain #209/#221. Update audit docs to direct users to
    `lidarr reconcile` while keeping `plex-alignment` reserved.

- **B10 — Update roadmap state only at completion**
  - **Depends on:** B9 and all validation passing.
  - **Owns:** `ROADMAP.md`, `docs/roadmap-archive.md`.
  - Mark only #208 and its two child deliverables complete after authoritative merge/CI evidence.
    Preserve #209/#221 as dependent future work and do not describe mutation capability as shipped.

- **B11 — Final validation gate**
  - **Depends on:** B2 through B10.
  - Run the focused bridge mapping/cache/reconcile, action, command, audit reserved-slot, command
    hierarchy, and completion parity tests. Then run rfmedia typecheck/build/full package tests,
    architecture tests, and Lidarr generated-client/codegen drift checks. Build `rf-common` first
    in the fresh worktree if module resolution requires it. No OpenAPI refresh or generated-client
    change is expected.

## Task Granularity

- Keep implementation tasks to one coherent boundary and one to three owned files. Source and its
  focused test stay together when possible; the three shell templates are intentionally one unit
  because partial ownership creates parity drift.
- Child A owns snapshot representation, construction, canonical offline selectors, and cache SQL.
  Child B consumes those contracts and must not reopen their policy except for additive
  reconciliation result types.
- Separate pure engine, action, command, registration, completion, and docs so work can proceed
  without multiple tasks editing the same large parent modules.
- Minimize tests by boundary:
  - mapping proves complete snapshot-v2 target retention;
  - cache proves strict persistence and exact scope selection;
  - pure engine proves all classification mathematics;
  - action proves online/offline orchestration and no-I/O/no-write guarantees;
  - command proves formatting, redaction, and exit semantics;
  - hierarchy/completion tests prove public surface parity.
- Prefer parameterized tables and existing fixtures. Do not add duplicate full-output snapshots,
  per-format copies of every category case, generated-client tests, database migration tests, or
  provider mutation tests unless implementation actually changes those contracts.
- A SQL schema-version task is deliberately absent: snapshot v2 lives in `payload_json`. Add a
  migration task only if implementation proves indexed columns are necessary for bounded scope
  selection.

## Dependency Analysis

The critical path is:

`A1 → A2 → A4 → B3 → B4 → B5/B6/B7 → B8/B9 → B10 → B11`

The pure-report path is:

`Child A merged → B1 → B2 → B3`

A3a and A3b can run in parallel with A1/A2, but both must land before B3's strict offline branch.
B1/B2 can begin after Child A's public snapshot contract is merged; B2 does not depend on provider,
database, command, or completion code. After B4 freezes the CLI surface, B5, B6, and B7 are
independent ownership lanes. B8 waits for registration and all three templates; B9 waits for the
final CLI/audit behavior; B10 waits for verified implementation and docs.

There is no circular dependency:

- mapping constructs the versioned evidence;
- cache stores/selects it;
- reconcile purely projects it;
- the action owns I/O and calls the projector;
- the command owns parsing/presentation and calls the action;
- completions/docs describe the command;
- audit remains a reserved pointer to the command rather than importing it.

Child B must not make Child A depend on reconciliation result types, and audit must not call the
command/action or implement a parallel matcher. Mutations and policy evaluation have no incoming
or outgoing task edges in this plan.

## File-to-Task Mapping

| File                                                               | Owning task                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `packages/rfmedia-cli/src/types/bridge.ts`                         | A1 — snapshot-v2 and scope-selection contracts               |
| `packages/rfmedia-cli/src/types/index.ts`                          | A1 for snapshot exports; B1 later for reconciliation exports |
| `packages/rfmedia-cli/src/lib/bridge/mapping.ts`                   | A2 — construct complete target catalog                       |
| `packages/rfmedia-cli/src/lib/bridge/mapping.test.ts`              | A2 — snapshot-v2 construction contract                       |
| `packages/rfmedia-cli/src/lib/adapters/index.ts`                   | A3a — credential-free Plex-origin resolver                   |
| `packages/rfmedia-cli/src/lib/adapters/index.test.ts`              | A3a — Plex-origin security contract                          |
| `packages/rfmedia-cli/src/lib/lidarr/index.ts`                     | A3b — credential-free Lidarr-origin resolver                 |
| `packages/rfmedia-cli/src/lib/lidarr/index.test.ts`                | A3b — Lidarr-origin compatibility contract                   |
| `packages/rfmedia-cli/src/lib/bridge/cache.ts`                     | A4 — strict v2 projection and compatible-scope SQL           |
| `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`                | A4 — v2/cache-selection contract                             |
| `packages/rfmedia-cli/src/types/bridge-reconcile.ts`               | B1 — public reconciliation result contract                   |
| `packages/rfmedia-cli/src/lib/bridge/reconcile.ts`                 | B2 — pure bidirectional engine                               |
| `packages/rfmedia-cli/src/lib/bridge/reconcile.test.ts`            | B2 — classification matrix                                   |
| `packages/rfmedia-cli/src/actions/lidarr/reconcile.ts`             | B3 — online/offline orchestration                            |
| `packages/rfmedia-cli/src/actions/lidarr/reconcile.test.ts`        | B3 — orchestration invariants                                |
| `packages/rfmedia-cli/src/actions/lidarr/index.ts`                 | B3 — action export                                           |
| `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts`            | B4 — CLI leaf and presenters                                 |
| `packages/rfmedia-cli/src/commands/lidarr-reconcile.test.ts`       | B4 — CLI/output/failure contract                             |
| `packages/rfmedia-cli/src/commands/lidarr.ts`                      | B5 — leaf registration and shared dependency injection       |
| `packages/rfmedia-cli/src/commands/lidarr.test.ts`                 | B5 — exact hierarchy/global-option contract                  |
| `packages/rfmedia-cli/src/actions/lidarr/audit.ts`                 | B6 — reserved gather-slot detail correction                  |
| `packages/rfmedia-cli/src/lib/lidarr/audit.ts`                     | B6 — reserved evaluator detail correction                    |
| `packages/rfmedia-cli/src/lib/lidarr/audit.test.ts`                | B6 — reserved-slot compatibility assertion                   |
| `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`           | B7 — Bash reconcile completion                               |
| `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`            | B7 — Zsh reconcile completion                                |
| `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`           | B7 — Fish reconcile completion                               |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` | B8 — cross-shell exact parity                                |
| `packages/rfmedia-cli/docs/features/plex-lidarr-reconciliation.md` | B9 — focused operator guide                                  |
| `packages/rfmedia-cli/README.md`                                   | B9 — command reference                                       |
| `packages/rfmedia-cli/docs/features/lidarr-audit.md`               | B9 — reserved-slot guidance                                  |
| `ROADMAP.md`                                                       | B10 — live roadmap status                                    |
| `docs/roadmap-archive.md`                                          | B10 — shipped-history record                                 |
