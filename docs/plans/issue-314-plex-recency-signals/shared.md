# Issue #314 Plex Recency Consumption Signals

Issue #314 extends the existing Plex-to-policy track pipeline with an optional `lastViewedAt` epoch-seconds signal while preserving the private wire/provider-neutral domain boundary. The existing bounded `plexTrackPlays` drain and one-pass normalized-name join will aggregate the latest trustworthy view without a second request, and missing or partial recency will remain unavailable evidence. `stale-monitoring-cleanup` gains an opt-in `minDaysSinceLastViewed` conjunct evaluated against the action's captured clock, with stable raw evidence in explain output and fingerprints. The change remains read-only and config-only: no database, timeline, plan-operation, filter-pushdown, CLI-option, or shell-completion surface is added.

## Relevant Files

- `docs/plans/issue-314-plex-recency-signals/requirements.md`: Acceptance contract and scope constraints.
- `docs/plans/issue-314-plex-recency-signals/design.md`: Binding field, join, rule, fingerprint, and test decisions.
- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`: Private track wire type and runtime guard.
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`: Sole Plex-to-`MediaTrack` projection.
- `packages/rfmedia-cli/src/types/media-server.ts`: Provider-neutral track domain contract.
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`: Guard-plus-mapper page boundary used by policy drains.
- `packages/rfmedia-cli/src/types/config.ts`: Public stale-policy configuration shape.
- `packages/rfmedia-cli/src/lib/config.ts`: Exact-key and bounded-value configuration validation.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: Policy report, observation, comparator, resolved-rule, and join contracts.
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`: Injected clock and evaluation composition boundary.
- `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts`: Existing bounded full-track signal gatherer.
- `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts`: Single-pass play and recency normalized-name aggregation.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: Resolved config, report version, indexes, and evaluator input.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-shared.ts`: Exact config paths and deterministic rule helpers.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts`: Fail-closed time-aware policy gate.
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`: Stable evidence fingerprint allowlists and projection.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: Policy threshold footer and explain rendering.
- `packages/rfmedia-cli/src/lib/adapters/plex/types.test.ts`: Wire acceptance and malformed-field coverage.
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.test.ts`: Mapper presence/absence coverage.
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.test.ts`: Adapter-boundary integration coverage.
- `packages/rfmedia-cli/src/lib/config.test.ts`: Exact config-path and bounds coverage.
- `packages/rfmedia-cli/src/lib/bridge/policy-signals.test.ts`: Join aggregation and gap coverage.
- `packages/rfmedia-cli/src/lib/bridge/policy-rules.test.ts`: Pinned-clock stale decision matrix.
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.test.ts`: Stable and rotating fingerprint cases.
- `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts`: Explain-output contract coverage.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: Primary public behavior and safety guide.
- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`: Shared policy-config behavior for sync-ratings.
- `packages/rfmedia-cli/README.md`: Public CLI configuration summary.
- `rfmedia.example.yaml`: Discoverable policy configuration example.
- `ROADMAP.md`: Live issue completion status.

## Relevant Patterns

**Private Wire Boundary**: Validate optional Plex fields in `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`, then map once through `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`; no Plex type escapes the adapter.

**Missing Evidence Is Data**: Model absent or partial recency with named `PolicyObservationGap` values in `packages/rfmedia-cli/src/types/lidarr-policy.ts`, following `lookupArtistPlays` in `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts`.

**Single Complete Drain and Join**: Reuse `gatherPlexTrackPlays` and extend `buildTrackJoinSummary` so play and recency data come from one bounded snapshot and one normalization pass.

**Pure Pinned-Time Rule**: Thread the action's `evaluatedAt` into `PolicyEvaluationInput`; `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts` performs no I/O or wall-clock read.

**Stable Review Evidence**: Store raw `lastViewedAt` plus the configured day threshold in proposal evidence; never fingerprint a moving cutoff or computed age. Follow the canonical projection in `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`.

**Exact Config Paths**: Add the key to the stale rule's exact-key validator and central `POLICY_CONFIG_PATH`; every explain check names `policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed`.

**Focused Contract Tests**: Extend the existing wire, mapper, query, config, join, rule, explain, and fingerprint suites only where each proves a distinct changed boundary.

## Relevant Docs

**`docs/plans/issue-314-plex-recency-signals/requirements.md`**: You _must_ read this when confirming acceptance scope or completion evidence.

**`docs/plans/issue-314-plex-recency-signals/design.md`**: You _must_ read this before implementation; its scope, conjunctive rule semantics, temporal check, and fingerprint decisions are binding.

**`packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md`**: You _must_ read sections 2.4, 6.2, 8, 9, 14, and 15 when changing the parent policy contract.

**`packages/rfmedia-cli/docs/features/media-server-adapter.md`**: You _must_ read this when changing wire/domain projection or adapter capabilities.

**`packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`**: You _must_ read and update this when changing stale-policy behavior, safety gates, configuration, or explain output.

**`packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`**: You _must_ read and update this because sync-ratings consumes the same policy configuration.

**`packages/rfmedia-cli/CLAUDE.md`**: You _must_ read this for architecture gates, Node/runtime commands, tests, and Bash/Zsh/Fish completion parity.

**`.github/workflows/rfmedia-cli.yml`**: You _must_ read this before final verification so local evidence matches registered CI.

**`ROADMAP.md` and `docs/roadmap-archive.md`**: You _must_ read these during closeout to keep live and historical completion statements consistent.
