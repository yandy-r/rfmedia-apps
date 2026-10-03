# Issue #208 Pattern Analysis

## Executive Summary

Issue #207 already provides most of the difficult identity foundation for `rfmedia lidarr
reconcile`: bounded Plex artist/MBID acquisition, the provider-neutral adapter capability, an
MBID-first deterministic resolver, typed uncertainty states, and strict SQLite snapshot
persistence. Issue #208 should compose those pieces into a read-and-suggest command, add a small
pure bidirectional projection for `plex_only`, `lidarr_only`, and match-evidence categories, and
reuse the existing Lidarr command/action/presenter and shell-completion conventions.

No child issue is required for the core artist-level reconciliation contract. Actual provider
mutations, quality-profile comparison, album/file stale-state repair, or interactive duplicate
merging should remain outside this issue unless they are expressed through the existing sealed
Lidarr plan/apply system; implementing those broader research ideas as direct `reconcile` writes
would exceed the issue's medium scope and bypass established mutation safety.

## Implementation Patterns

### Keep command, action, and reconciliation logic separate

- Add a DI-factory command sibling such as
  `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts`, following
  `commands/lidarr-audit.ts` and `commands/lidarr-search.ts`. The sibling must not import
  `commands/lidarr.ts`; the parent injects `resolveFormat`, `reportLidarrFailure`, and
  `renderExecutionSummary`, then registers the returned leaf in documented order.
- Add `packages/rfmedia-cli/src/actions/lidarr/reconcile.ts` as the sole I/O owner. It should
  resolve connection/configuration, gather complete provider projections, schedule the work,
  read/write the snapshot cache, and return a frozen typed result.
- Add `packages/rfmedia-cli/src/lib/bridge/reconcile.ts` as a pure synchronous projector over
  `BridgeArtistIdentitySnapshot` plus the complete Lidarr artist projection. It must not import
  clients, adapters, generated types, commands, formatters, or database code.
- Export the action and its tier from `src/actions/lidarr/index.ts`; keep provider and database
  rows behind their existing boundaries.

### Build on the existing identity resolver, not a second matcher

- `resolveArtistIdentities()` in `src/lib/bridge/mapping.ts` is the authoritative policy:
  canonical exact artist MBID is the only automatic match. Name-derived matches are
  `suggested`, never authoritative.
- Preserve its frozen discriminated outcomes:
  `resolved`, `suggested`, `ambiguous`, `unmatched`, `conflict`, and `unavailable`, with stable
  reason codes.
- Do not copy the older research example's `85% confidence threshold`. Current constants are a
  `0.90` score floor and `0.08` runner-up margin, and the type contract explicitly says a score
  is similarity evidence, not probability or confidence.
- Model "match-confidence categories" as stable categorical evidence, for example exact,
  suggested, ambiguous, unmatched, conflict, and unavailable. If the public schema retains the
  word `confidence`, document it as a category, never as a probability.
- Derive `plex_only` from complete Plex-source outcomes that have no authoritative Lidarr match.
  Keep `suggested`, `ambiguous`, and `conflict` evidence visible rather than silently promoting a
  name candidate.
- Derive `lidarr_only` by subtracting the Lidarr IDs consumed by `resolved` exact-MBID outcomes
  from the complete target catalog. Name suggestions must not remove a target from this set unless
  the output explicitly presents a separate review-only overlap.
- Make category membership and summary counts deterministic and auditable. Sort by stable IDs
  first, apply documented title tie-breakers only for presentation, return fresh frozen arrays,
  and ensure every input artist is accounted for exactly once in the primary classification.

### Gather complete live evidence before analysis or persistence

- Resolve Plex only through `resolveRequiredMediaServerAdapter()`. Require
  `adapter.identity`; a missing optional capability is a typed configuration/capability failure,
  not a reason to import private Plex code.
- Call `identity.getInstanceId()` once and page `identity.listArtists()` with its `AbortSignal`
  until `hasMore` is false. Retain the first page's stable `libraryId`, reject a later page that
  changes scope, and fail closed on stalled/incomplete pagination. The adapter already validates
  page size, offsets, GUID bounds, terminal-safe values, and response arithmetic.
- Resolve Lidarr through the handwritten `LidarrClientApi` facade and use
  `client.listArtists(signal)`. Never import generated Lidarr modules or write `/api/v1/` paths.
- Run live reconciliation as one idempotent `local-only` scheduled operation, consistent with
  audit/list actions. Forward cancellation to both providers and do not nest another scheduler
  task while holding a lane slot.
- Call `resolveArtistIdentities()` only after both catalogs are complete. Its hard limits are
  10,000 artists per side, 16 MiB normalized text, and one million pairwise name comparisons;
  expose those failures rather than truncating.
- Replace the bridge cache only after the complete snapshot validates. The existing cache performs
  strict unknown-to-domain projection, payload byte limits, full-scope atomic upsert, and
  newer-generation-wins ordering. A cache-write failure should follow an explicit product
  contract; search treats cache population as non-fatal, while the bridge cache itself throws
  typed failures.

### Make offline mode an explicit execution path

- `--offline` should make zero Plex or Lidarr network requests. Open the configured tracking
  database with `openDatabaseReadOnly()` and close it in `finally`; this API uses an immutable
  in-memory snapshot and rejects symlinks, active SQLite sidecars, and schema versions other than
  v11.
- Return the cache-derived provenance already produced by
  `readBridgeIdentitySnapshot()`: `source: "sqlite-cache"`, `mode: "offline"`,
  `freshness: "stale"`, and `ageSeconds`.
- Do not reuse generic `--allow-stale` semantics. That path attempts Lidarr live first and uses a
  category-specific terminal fallback; issue #208 calls for a true offline snapshot mode spanning
  both providers.
- Treat missing, corrupt, incompatible, ambiguous-scope, or incomplete cached evidence as typed
  unavailable/failure output. Never fall through to live requests during `--offline`.

### Suggestions are data; mutations use plan/apply

- Duplicate reporting may reuse the concepts in `lib/lidarr/audit-identity.ts`: exact MBID
  collisions, case-sensitive normalized paths, and folded-name groups are deterministic O(n)
  buckets. Put bridge-specific grouping in `lib/bridge/reconcile.ts`; do not make reconciliation
  depend on an audit-private module.
- Suggestions should include stable target IDs/MBIDs, reason codes, review state, and safe command
  text. Names alone never authorize a target.
- A default run must not mutate Plex, Lidarr, files, plans, or monitoring state. Internal cache
  population after a complete live read is analogous to existing lookup caching and should be
  distinguished from provider mutation in the command documentation.
- If `--apply` is retained, it must not call Lidarr mutation methods directly. Reuse or extend the
  sealed plan/apply engine: exact IDs, bounded batches, reviewed checksums, live-state
  revalidation, explicit authorization, and later `rfmedia lidarr apply`. Plex-only artist adds
  already have an `artist-add` plan family, but its current producer is discovery-specific and
  requires reviewed resource policy; adapting that is materially larger than emitting
  reconciliation suggestions.

### Follow the established presentation contract

- Human output goes to stderr and should show a compact summary followed by bounded tables for
  exact matches, `plex_only`, `lidarr_only`, review-only matches, conflicts, and duplicates.
  Support `-v, --verbose` for uncapped detail and always reveal degraded/offline provenance.
- Machine output goes through `formatOutput()`. JSON/YAML should use the stable envelope
  `{ command: "lidarr-reconcile", result }`.
- CSV needs an explicit flat schema with a `rowType` discriminator, following audit/search:
  one summary row followed by entity/match/duplicate rows. Encode nested evidence as JSON cells and
  pass a fixed column list to `formatOutput()`.
- Validate CLI combinations inside the action handler's `try` before lazy-importing the action.
  Commander argument parsers that throw can bypass the shared Lidarr failure envelope.
- Route every failure through `reportLidarrFailure("reconcile", ...)`, set
  `staleHint: false`, and include both Lidarr API key and Plex token in `sensitiveValues`.
  The helper produces redacted text or machine envelopes and sets `process.exitCode = 1` without
  `process.exit()`.

## Existing Code Structure

- `packages/rfmedia-cli/src/types/bridge.ts`: existing scope, resolver versions and bounds,
  immutable outcomes, provenance/completeness, cache errors, and expansion-impact contracts; add
  reconciliation result/category types here.
- `packages/rfmedia-cli/src/lib/bridge/mapping.ts`: exact-MBID-first resolver and name suggestion
  policy; consume it unchanged from the new bridge projector.
- `packages/rfmedia-cli/src/lib/bridge/cache.ts`: sole owner of
  `bridge_identity_snapshots` CRUD and strict cache reprojection.
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`: bounded/cancellable Plex artist GUID
  pages and stable server identity through the provider-neutral capability.
- `packages/rfmedia-cli/src/types/media-server.ts`: optional
  `MediaServerIdentityCapability`; action code must narrow its presence.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`: composes the identity capability around
  the single origin-bound Plex transport.
- `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts`: required media-server adapter
  resolution boundary.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: handwritten façade exposing complete
  `listArtists()` projections.
- `packages/rfmedia-cli/src/actions/lidarr/audit.ts`: closest multi-source action and
  `local-only` scheduling/degradation precedent, but its identity slot is stale.
- `packages/rfmedia-cli/src/commands/lidarr-audit.ts`: closest DI command, human report,
  JSON/YAML/CSV, preflight validation, redaction, and exit-code pattern.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: parent namespace, shared failure/output helpers,
  and leaf registration order.
- `packages/rfmedia-cli/src/lib/db.ts`: writable initialization for live cache replacement and
  immutable read-only opening for offline mode.
- `packages/rfmedia-cli/src/lib/config.ts`: `resolveUndoDatabasePath()` resolves the shared
  tracking database path from undo/tracking/default configuration.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts`: three manually maintained
  completion templates.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: cross-shell command-tree,
  exact-option, value-argument, and zero-side-effect parity tests.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: architecture gate for Plex
  transport ownership, generated Lidarr privacy, fetch ownership, and mutation ownership.

## Code Conventions

- TypeScript is strict ESM/NodeNext; relative imports use `.js` extensions.
- Public domain shapes use readonly fields, discriminated unions, stable literal reason codes, and
  `Object.freeze()` at returned boundaries. Exhaustive switches assign the default arm to `never`.
- Provider responses and cached JSON begin as `unknown` and are strictly projected with byte,
  cardinality, safe-integer, canonical-origin, terminal-control, and semantic checks. Type
  assertions are not validation.
- Origins are credential-free and canonical. Tokens/API keys stay in providers and redaction
  lists; they never enter cache scope, output, logs, plan checksums, or thrown messages.
- Complete evidence is distinct from a successful match. Partial enumeration must fail closed;
  an empty complete catalog is valid.
- Results have stable deterministic ordering independent of provider input order. Duplicate
  identifiers are counted/grouped once, and absent optional identifiers never become bucket keys.
- Commands lazy-import actions after local validation, use help groups, preserve global
  `--json`/`--output` handling, and render human output on stderr.
- JSDoc explains safety invariants and unusual decisions, especially why a tempting fallback is
  rejected.

## Integration Points

### Required CLI and completion parity

- Register `reconcile` in `lidarrCommand` and in Bash `lidarr_subcommands`, Zsh
  `lidarr_subcmds`, and Fish's Lidarr subcommand candidates.
- Add exact leaf options in all three templates. At minimum the issue requires connection
  overrides, Plex library selection, `--offline`, duplicate-detail selection, and verbosity; add
  any apply/plan options only if the mutation handoff is actually implemented.
- Extend `templates.spec.ts` with one shared expected option array and assertions that Bash, Zsh,
  and Fish expose identical options, value-taking behavior, static candidates, and no
  client/config/network side effects.
- Add the command to `packages/rfmedia-cli/README.md` and create a focused feature document; update
  CLI help/registration assertions where present.

### Critical tests

- `lib/bridge/reconcile.test.ts`: exact matches, Plex-only and Lidarr-only symmetry, empty sides,
  suggestion/ambiguity/conflict accounting, target reuse prevention, duplicate groups, stable
  ordering across input permutations, frozen output, and summary/detail count parity.
- `actions/lidarr/reconcile.test.ts`: complete Plex pagination, stable scope capture, single
  Lidarr list, cancellation, missing identity capability, incomplete/stalled provider evidence,
  resolver bounds, atomic cache replacement only after success, exact offline cache hit, and zero
  provider construction/network calls offline.
- `commands/lidarr-reconcile.test.ts`: option forwarding, validation before action import,
  human truncation/verbose behavior, JSON/YAML envelope, fixed CSV columns/row order, offline
  provenance, failure envelope, secret redaction, and exit status.
- Extend bridge cache tests if partial-scope discovery is added: zero/one/multiple matches,
  credential-free filtering, deterministic ambiguity, corrupt rows, and read-only database
  behavior.
- Update audit tests if `plex-alignment` is activated or redirected; its current reserved behavior
  and documentation explicitly claim #207/#208 have not shipped.
- Run targeted Vitest tests plus package `test:run`, `typecheck`, `build`, architecture tests,
  Lidarr codegen checks, and the root completion/contract gates. No OpenAPI refresh or generated
  client change should be needed.

## Gotchas and Warnings

- **Offline scope cannot currently be discovered safely.** `readBridgeIdentitySnapshot()` requires
  the complete key: Plex origin, machine ID, library ID, Lidarr origin, and entity kind. During a
  true outage the command cannot ask Plex for machine/library IDs, and the cache exposes no
  partial-scope query. Add a strictly projected cache lookup that returns zero/one/many scope
  candidates, or require explicit opaque scope selectors; never choose an arbitrary row by origin.
- **Cached snapshots contain source outcomes, not the original full Lidarr target catalog.**
  `lidarr_only` cannot be reconstructed from outcomes alone when a Lidarr artist was never a
  candidate. Issue #208 must either version/extend the persisted snapshot with the complete
  projected target catalog or persist a reconciliation projection that includes target coverage.
  This is the most important offline data-model gap.
- **The existing resolver is deliberately one-way.** It produces one outcome per Plex artist.
  Bidirectional target coverage belongs in the new pure reconcile layer, not in ad hoc command
  counting.
- **A malformed or duplicate Lidarr MBID currently poisons every source outcome.**
  `prepareTargets()` records global malformed/duplicate state and `resolveOne()` returns conflict
  before considering an otherwise unrelated exact match. Preserve the fail-closed snapshot, but
  report the duplicate group explicitly so operators can distinguish a global integrity conflict
  from a normal gap.
- **`plex-alignment` is still hard-coded unavailable.** `actions/lidarr/audit.ts`,
  `lib/lidarr/audit.ts`, `types/lidarr-audit.ts`, tests, completions, and
  `docs/features/lidarr-audit.md` reserve the check until #207/#208. Shipping reconciliation while
  leaving the message "Plex artists carry no MusicBrainz id" would be factually wrong. Either
  activate the check from reconciliation evidence in this issue or update it to point users to
  `rfmedia lidarr reconcile`; do not leave the stale contract.
- **The issue's stated “3-5 files” is no longer realistic.** Repository contracts require a
  command sibling/action export, pure engine/types, tests, three completion templates, parity
  tests, and docs. Treat the listed affected files as architectural intent, not a change cap.
- **Old strategic research is not current code guidance.** It references the retired direct Plex
  module, a fuzzy confidence threshold, quality mismatch, stale monitoring repair, and direct
  resolution flags. The current adapter boundary, #207 resolver, and sealed Lidarr plan/apply
  engine supersede those sketches.
- **Do not equate local cache writes with provider apply.** Document the distinction. If the issue
  owner interprets “all writes” literally, add an explicit cache-refresh consent flag; otherwise
  follow existing lookup behavior and treat complete-snapshot cache population as internal
  non-fatal persistence while keeping every Plex/Lidarr/filesystem mutation behind reviewed apply.
- **Suggestions cannot safely become immediate actions.** Exact MBID may authorize identity, but
  artist addition still needs root folder, quality profile, metadata profile, monitoring policy,
  and sealed expected-absence evidence. Duplicate removal additionally needs file-impact evidence
  and explicit artist/file-delete authorization.
