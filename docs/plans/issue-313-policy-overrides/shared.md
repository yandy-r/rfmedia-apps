# Policy Decision Overrides and Disputes

The rfmedia CLI loads one validated config snapshot, gathers Plex/Lidarr evidence, and produces a
frozen policy report whose `proposals` collection is the sole actionable input to policy-plan and
ratings-sync projectors. This feature adds strict config selection for the three override-sensitive
command paths and a pure post-cap engine pass that fingerprints, classifies, exposes, and withholds
disputed proposals before report counts are frozen. Presenters surface active, stale, and
not-evaluated override records while unchanged plan producers and guarded apply actions receive only
remaining actionable proposals; no new client, database, endpoint, CLI option, or mutation authority
is introduced.

## Relevant Files

- packages/rfmedia-cli/src/cli.ts: Select strict loading for exact sensitive command ancestry.
- packages/rfmedia-cli/src/lib/config.ts: Validate overrides and fail closed when explicitly strict.
- packages/rfmedia-cli/src/types/config.ts: Define raw default-free override configuration types.
- packages/rfmedia-cli/src/types/lidarr-policy.ts: Define policy v2 fingerprints, results, and counts.
- packages/rfmedia-cli/src/lib/bridge/policy-engine.ts: Classify after caps, then recount and freeze.
- packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts: Stable proposal and skip key grammar.
- packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts: Pass loaded config and resolved scope.
- packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts: Render human, explain, and CSV evidence.
- packages/rfmedia-cli/src/commands/lidarr-policy.ts: Preserve machine envelopes and post-render exits.
- packages/rfmedia-cli/src/lib/bridge/policy-plan.ts: Project only authoritative actionable proposals.
- packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts: Stop before producers on withheld-only runs.
- packages/rfmedia-cli/src/lib/bridge/rating-sync.ts: Build cohorts only from actionable proposals.
- packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts: Preserve recommend-plan-apply safety ladder.
- packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts: Show overrides in human sync output.
- packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts: Audit unchanged Bash/Zsh/Fish parity.
- packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md: Document full dispute workflow.
- packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md: Document downstream withholding boundary.
- packages/rfmedia-cli/README.md: Add discoverable config and strict-loading summary.
- ROADMAP.md: Record final issue and pull-request delivery after live verification.

## Relevant Patterns

**Functional core and imperative shell**: Keep evidence I/O in actions and deterministic override
processing in [/packages/rfmedia-cli/src/lib/bridge/policy-engine.ts](/packages/rfmedia-cli/src/lib/bridge/policy-engine.ts).

**Single actionable collection**: Filter once before freezing the report, then let
[/packages/rfmedia-cli/src/lib/bridge/policy-plan.ts](/packages/rfmedia-cli/src/lib/bridge/policy-plan.ts)
and [/packages/rfmedia-cli/src/lib/bridge/rating-sync.ts](/packages/rfmedia-cli/src/lib/bridge/rating-sync.ts)
continue to consume only `report.proposals`.

**Immutable typed reports**: Create new frozen report-grade proposals and result arrays rather than
mutating rule output, following
[/packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts](/packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts).

**Closed validated configuration**: Preserve exact `ConfigError` paths, reject unknown or hostile
keys, and resolve runtime defaults only at the engine boundary, following
[/packages/rfmedia-cli/src/lib/config.ts](/packages/rfmedia-cli/src/lib/config.ts).

**Strict mode by exact command ancestry**: Match only `lidarr policy evaluate`, `lidarr policy plan`,
and `lidarr sync-ratings` in [/packages/rfmedia-cli/src/cli.ts](/packages/rfmedia-cli/src/cli.ts), so
unrelated commands keep permissive config fallback behavior.

**Shared presentation projection**: Extend one evaluation presenter for human, explain, and CSV
state, following
[/packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts](/packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts).

**Review, seal, and apply separation**: Overrides withhold same-run proposals but cannot create,
rewrite, authorize, or revoke sealed artifacts, following
[/packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts](/packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts).

**Critical boundary tests**: Pin the pure hash/classifier, engine counts, strict loader, presenter,
one plan boundary, one apply boundary, and unchanged completion parity without duplicating generic
serializer or sanitizer coverage.

## Relevant Docs

**/docs/plans/issue-313-policy-overrides/feature-spec.md**: You _must_ read this for the binding
scope, fingerprint tuple, status lifecycle, schema, safety, and acceptance contracts.

**/docs/plans/issue-313-policy-overrides/research-architecture.md**: You _must_ read this when
changing engine placement, counts, presenters, projectors, or mutation boundaries.

**/docs/plans/issue-313-policy-overrides/research-patterns.md**: You _must_ read this when adding
types, validation, frozen values, strict loading, CSV rows, or focused tests.

**/docs/plans/issue-313-policy-overrides/research-integration.md**: You _must_ read this when
changing CLI ancestry, nested schemas, config precedence, action boundaries, or completions.

**/docs/plans/issue-313-policy-overrides/research-docs.md**: You _must_ read this when updating the
feature guides, README, roadmap, examples, terminology, or safety wording.

**/packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md**: You _must_ read this when
changing decision keys, evaluation output, policy planning, config, or dispute workflow.

**/packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md**: You _must_ read this when changing
recommend, plan, apply, or embedded policy evaluation behavior.
