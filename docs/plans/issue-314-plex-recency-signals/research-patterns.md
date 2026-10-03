# Pattern Research: issue-314-plex-recency-signals

## Architectural Patterns

- Keep the provider boundary coordinated and one-way: private Plex DTOs in
  `packages/rfmedia-cli/src/lib/adapters/plex/types.ts` are validated by
  `isPlexWireTrack`, projected by `mapPlexTrack` in
  `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`, and exposed only as the
  provider-neutral `MediaTrack` in `packages/rfmedia-cli/src/types/media-server.ts`.
  Recency therefore belongs on all three surfaces together; no Plex wire field should escape the
  private adapter directory.
- Reuse the existing `plexTrackPlays` data path rather than adding another network read. The action
  already performs a complete, bounded track drain in
  `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts`, places the tracks in the discriminated
  `PolicySignalBundle` from `packages/rfmedia-cli/src/types/lidarr-policy.ts`, and gives the pure
  layer raw `MediaTrack[]`. The slot name is play-oriented, but its payload is already the complete
  track domain object and can carry consumption recency without a second signal or endpoint.
- Extend the one-pass join summary in
  `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts`. `buildTrackJoinSummary` is deliberately
  computed once by `buildIndexes` in `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`, then
  shared with both the index and coverage projection. Artist recency should be aggregated in that
  same traversal and under the same normalized-name poisoning rules as plays; do not normalize or
  walk the full library again in the stale evaluator.
- Preserve the strength of the current join. `MediaTrack` has no artist id, so both plays and
  recency inherit the `normalized-name` grade and its fail-closed behavior for ambiguous names,
  the `Unknown Artist` sentinel, and unjoined tracks. The exact examples are
  `buildTrackJoinSummary`, `lookupArtistPlays`, and `PolicyPlayIndex` in
  `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts` and
  `packages/rfmedia-cli/src/types/lidarr-policy.ts`.
- A timestamp does not solve the never-viewed case by itself. An artist whose joined tracks have no
  `lastViewedAt` remains indistinguishable as newly added versus abandoned; `skipCount` also does
  not provide age. A safe first increment can express recency only when a trustworthy last-viewed
  observation exists and must refuse the all-missing case. If the product requirement includes
  aging never-viewed artists, item `addedAt` (or another explicit acquisition timestamp) is a
  required separately designed signal rather than an implicit epoch-zero fallback.
- Use the run's injected clock. `executeLidarrPolicyEvaluate` already supplies `now: () => Date` in
  `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`, and
  `PolicyEvaluationRunInput.evaluatedAt` is carried by
  `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`. A day-based cutoff should be derived once
  from that pinned evaluation time and passed through pure evaluator input; never call `Date.now()`
  inside `evaluateStaleMonitoringCleanup`.
- The named filter DSL and Plex pushdown are not required for issue #314's policy path. The policy
  gatherer calls `adapter.query.tracks` without a filter because a complete drain is a safety
  invariant. Pushing only old rows would hide a recent row and could manufacture a stale verdict.
  The optional filter chain (`MediaFilterField` in
  `packages/rfmedia-cli/src/types/media-filters.ts`, `getMediaFieldValue` in
  `packages/rfmedia-cli/src/lib/media-filter-evaluator.ts`, `plexFilterEntry` / `buildPushdown` in
  `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`, and `PLEX_FEATURES` in
  `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`) should remain unchanged unless a separate
  user-facing query requirement is accepted.

## Code Conventions

- Model Plex epoch timestamps as optional finite numbers, following
  `PlexWirePlaylist.addedAt?: number` and `MediaPlaylist.createdAt?: number` in
  `packages/rfmedia-cli/src/lib/adapters/plex/types.ts` and
  `packages/rfmedia-cli/src/types/media-server.ts`. The local wire guards treat omission as valid
  and reject a present non-number or non-finite number through `hasOptionalFiniteNumber`.
- Preserve absence at the mapper boundary. Existing count fields such as `viewCount` intentionally
  use `?? 0`, but recency must not: mapping an absent `lastViewedAt` to `0` turns missing evidence
  into "viewed in 1970" and fails open. Prefer `lastViewedAt: track.lastViewedAt` (and keep an
  optional `skipCount` optional unless the design explicitly proves Plex omission means zero).
- Keep contracts immutable and exhaustively typed: `readonly` interfaces, `as const` vocabularies,
  total `Record` maps with `satisfies`, frozen resolved policy/index/report objects, and exhaustive
  switches are the prevailing patterns in `packages/rfmedia-cli/src/types/lidarr-policy.ts`,
  `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`, and
  `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`.
- Keep `packages/rfmedia-cli/src/types/lidarr-policy.ts` free of value imports. New observation
  gaps, coverage members, resolved-rule members, or index types belong in that contract, but helper
  behavior belongs in `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts` or the rule module.
- Apply config defaults only in `resolvePolicyConfig` in
  `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`. The validator returns only operator-supplied
  values so `undefined` retains its "unset" meaning. Add any chosen recency key consistently to
  `PolicyStaleMonitoringConfigOptions`, `POLICY_STALE_MONITORING_KEYS`, the bounded validator,
  `POLICY_DEFAULTS`, `PolicyResolvedStaleMonitoring`, and `resolvePolicyConfig`.
- Centralize every configured threshold path in `POLICY_CONFIG_PATH` in
  `packages/rfmedia-cli/src/lib/bridge/policy-rule-shared.ts`. The stale evaluator should attach the
  exact path to its `PolicyThresholdCheck`; `renderExplainChecks` in
  `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts` already renders it without a
  recency-specific presentation branch.
- Policy proposal evidence is contract material. Observations and checks are hashed by
  `fingerprintPolicyProposal` in `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`; adding a
  recency observation or check intentionally changes stale-rule fingerprints. Update the hard-coded
  observation-gap allowlist and golden fingerprint tests there, and make an explicit schema decision
  for `POLICY_EVALUATION_SCHEMA`, `POLICY_ENGINE_VERSION`, and
  `POLICY_EVIDENCE_FINGERPRINT_SCHEMA` rather than silently changing machine output.
- `skipCount` is optional in issue #314. Do not let it enlarge the core change unless the selected
  stale criterion consumes it. If it is merely exposed in `MediaTrack`, keep it out of the policy
  check/fingerprint until a rule gives it defined semantics; otherwise defer it as a child issue.

## Error Handling

- Malformed present wire fields are rejected at the guard. `toPage` in
  `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts` converts a failed
  `isPlexWireMetadataResponse(..., isPlexWireTrack)` into typed `MediaServerError` invalid-response
  evidence; mapper range failures are converted to the same boundary classification. Do not allow a
  string, `null`, `NaN`, or infinity through as recency.
- Policy gathering never throws and never truncates. `gatherPlexTrackPlays` in
  `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts` converts adapter, pagination, abort, and
  bound failures to an unavailable slot. Preserve this behavior so a malformed recency row degrades
  the rule instead of producing a partial low-consumption cohort.
- Represent expected evidence gaps as data, not exceptions. `PolicyObservation` and
  `PolicyObservationGap` in `packages/rfmedia-cli/src/types/lidarr-policy.ts` plus
  `lookupArtistPlays` in `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts` are the model. A
  missing trustworthy recency aggregate needs a named unavailable reason and must become a visible
  skip/refusal in `evaluateStaleMonitoringCleanup`, never `0`, `new Date(0)`, or an omitted artist.
- Keep the current subject-level safety precedence in
  `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts`: monitoring convergence,
  trustworthy name join, rating veto, acquisition coverage, then configured thresholds. Recency is
  additional evidence, not permission to bypass `rating-protected`, missing Lidarr statistics, or
  `no-consumption-coverage`.
- Validate config with exact dotted paths. `validatePolicyStaleMonitoringConfig` in
  `packages/rfmedia-cli/src/lib/config.ts` first calls `rejectUnknownConfigKeys`, then uses bounded
  primitive validators with `policy.rules.stale-monitoring-cleanup.<field>`. The table-driven cases
  in `packages/rfmedia-cli/src/lib/config.test.ts` assert `ConfigError.propertyPath`; follow that
  pattern for wrong type, null, fractional, underflow, overflow, and typo cases.

## Testing Approach

- Keep tests focused on the changed contracts. In
  `packages/rfmedia-cli/src/lib/adapters/plex/types.test.ts`, add one accepted track carrying valid
  numeric recency, verify omission remains accepted, and add table cases for malformed present
  values. This proves the wire guard without duplicating every optional field permutation.
- In `packages/rfmedia-cli/src/lib/adapters/plex/mappers.test.ts`, prove numeric epoch/skip data map
  without leaking Plex names and, critically, prove omitted recency stays absent rather than becoming
  zero. Existing `mapPlexTrack` default tests are the exact fixture style to extend.
- Keep one adapter-boundary test in
  `packages/rfmedia-cli/src/lib/adapters/plex/query-library.test.ts`: the existing track-page test
  proves guard plus mapper integration, while its malformed-response test proves typed rejection.
  Add only the recency assertions necessary to establish that boundary.
- Put aggregation and missing/partial semantics in
  `packages/rfmedia-cli/src/lib/bridge/policy-signals.test.ts`: cover a recent observed maximum,
  all-missing recency, a played row missing its timestamp, mixed observed/missing rows according to
  the selected fail-closed rule, and preservation of ambiguous/sentinel poisoning. Do not create a
  parallel test file for the same join.
- Extend the critical stale decision matrix in
  `packages/rfmedia-cli/src/lib/bridge/policy-rules.test.ts` with a pinned evaluation time and only
  the decisive cases: exactly at the recency boundary, just recent, just stale, unavailable recency
  refusal, and coexistence with play/rating/acquisition gates. Assert the emitted check's observed
  value, comparator, bound, and exact config path, not only proposal count.
- Extend `packages/rfmedia-cli/src/lib/config.test.ts` for exact-path validation and
  `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts` for one `--explain` assertion showing the
  recency observation and dotted path. Existing JSON/YAML/CSV projection tests should be updated only
  where the public schema truly changes.
- Update `packages/rfmedia-cli/src/lib/bridge/policy-overrides.test.ts` when recency enters proposal
  evidence: pin the new golden hash and prove changing the timestamp or cutoff changes the evidence
  fingerprint. This is required safety coverage because existing suppressions must become visibly
  stale when their reviewed recency evidence changes.
- No shell-completion edit is required for a config-only threshold. If implementation adds a CLI
  option or rule id, audit all three templates at
  `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`, `zsh.ts`, and `fish.ts`, then run the
  parity contract in `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`.

## Patterns to Follow

- Follow `PlexWireTrack` / `hasCommonTrackFields` / `isPlexWireTrack` in
  `packages/rfmedia-cli/src/lib/adapters/plex/types.ts` for the wire contract and guard.
- Follow `mapPlexTrack` and the optional epoch mapping in `mapPlexPlaylist` in
  `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`; use optional epoch seconds, never an
  absence-to-zero recency default.
- Follow `buildTrackJoinSummary` plus `lookupArtistPlays` in
  `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts` for a single-pass, fail-closed artist
  aggregate with honest `normalized-name` provenance.
- Follow `evaluateStaleMonitoringCleanup` in
  `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts` for ordered safety gates,
  visible refusals, threshold checks, inert handoff, and deterministic cap behavior.
- Follow `validatePolicyStaleMonitoringConfig` in `packages/rfmedia-cli/src/lib/config.ts` and its
  table-driven cases in `packages/rfmedia-cli/src/lib/config.test.ts` for exact unknown-key and
  bounded-value errors.
- Follow `renderExplainObservations` and `renderExplainChecks` in
  `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`; enrich the generic observations and
  checks instead of adding bespoke prose-only recency output.
- Follow `fingerprintPolicyProposal` in
  `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts` so recency becomes copy-grade review
  evidence and stale overrides are classified honestly.
- Keep filter/pushdown and `skipCount` out of the first implementation unless the approved design
  assigns them a concrete user-visible contract. They are separable follow-ups; `lastViewedAt` plus
  the existing complete drain is the smallest coherent issue #314 slice, while never-viewed aging
  requires an explicit additional time source such as item `addedAt`.
