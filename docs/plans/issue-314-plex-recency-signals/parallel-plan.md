# Issue #314 Plex Recency Consumption Signals Implementation Plan

Extend the existing Plex track-to-policy path with an optional `lastViewedAt` epoch-seconds signal, preserving the private adapter boundary and missing evidence through the provider-neutral domain. Aggregate newest trustworthy recency in the existing bounded track drain and normalized-name join, then add an opt-in `minDaysSinceLastViewed` conjunct to `stale-monitoring-cleanup` using the already captured evaluation clock. Keep proposal evidence stable across clock passage, advance the public evaluation report to v3, and update only the focused tests and documentation required by issue #314. Do not add `skipCount`, timeline persistence, database changes, filter pushdown, CLI options, or completion tokens.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-issue-314-plex-recency-signals/ (branch: feat/issue-314-plex-recency-signals)

Before dispatching implementation tasks, create this one feature worktree and use the shared
`move-plan-to-worktree.sh` handoff so the complete untracked planning directory moves from the
primary checkout into the worktree exactly once. All task dependencies describe execution order;
phase headings are organizational and do not create additional barriers.

## Critically Relevant Files and Documentation

- `docs/plans/issue-314-plex-recency-signals/requirements.md`: Acceptance contract and proof matrix.
- `docs/plans/issue-314-plex-recency-signals/design.md`: Binding semantics, fail-closed matrix, and scope.
- `docs/plans/issue-314-plex-recency-signals/shared.md`: Condensed architecture and implementation patterns.
- `packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md`: Parent policy safety and output contract.
- `packages/rfmedia-cli/docs/features/media-server-adapter.md`: Provider-neutral adapter boundary.
- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`: Private Plex wire contract and guard.
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`: Plex-to-domain projection.
- `packages/rfmedia-cli/src/types/media-server.ts`: Provider-neutral `MediaTrack` contract.
- `packages/rfmedia-cli/src/types/config.ts`: Public policy configuration types.
- `packages/rfmedia-cli/src/lib/config.ts`: Exact policy config validation.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: Policy report, observation, index, and evaluator contracts.
- `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts`: One-pass normalized-name aggregation.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: Config resolution, indexes, and evaluation composition.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-shared.ts`: Config-path registry and rule helpers.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts`: Safety-critical stale evaluator.
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`: Evidence fingerprint closed vocabularies.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: Human explain and threshold footer.
- `.github/workflows/rfmedia-cli.yml`: Registered package CI contract.
- `packages/rfmedia-cli/CLAUDE.md`: Package architecture and validation commands.

## Implementation Plan

### Phase 1: Foundation Contracts

#### Task 1.1: Add the Plex wire and media-domain timestamp Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-314-plex-recency-signals/design.md`
- `packages/rfmedia-cli/docs/features/media-server-adapter.md`
- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`
- `packages/rfmedia-cli/src/types/media-server.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`
- `packages/rfmedia-cli/src/types/media-server.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/types.test.ts`

Add optional `lastViewedAt` to `PlexWireTrack` and `MediaTrack`, documented as whole Plex epoch seconds visible to the resolved credential. A present wire value must be a positive safe integer; omission remains valid. Add one compact malformed-value table covering nonnumber, nonfinite, fractional, zero, negative, and unsafe values plus accepted present/omitted cases. Do not add `skipCount` or alter existing `viewCount` behavior.

#### Task 1.2: Add the exact recency configuration key Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-314-plex-recency-signals/design.md`
- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/lib/config.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/lib/config.ts`
- `packages/rfmedia-cli/src/lib/config.test.ts`

Add optional `policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed`. Admit it in the exact stale-rule key set and validate a whole integer from 1 through 36,500 without injecting a default in the validator. Add focused accepted-bound and invalid equivalence-class tests, asserting `ConfigError.propertyPath` is exactly `policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed`.

### Phase 2: Adapter and Join Plumbing

#### Task 2.1: Preserve timestamp presence through the mapper boundary Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.test.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.test.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.test.ts`

Copy `lastViewedAt` into `MediaTrack` without a default and without exposing the private Plex DTO. Extend the existing mapper fixture to prove a valid timestamp survives and omission stays unavailable rather than becoming zero. Extend one existing query-page integration case to prove guard-plus-mapper propagation and malformed present-field rejection; do not modify the query implementation or add a new suite.

#### Task 2.2: Extend the policy contract and one-pass recency join Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-314-plex-recency-signals/design.md`
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/types/lidarr-policy.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-signals.test.ts`

Advance the policy evaluation schema and engine constants to v3/3. Add resolved `minDaysSinceLastViewed: number | null`, comparator `older-than-days`, observation gaps `no-recency-coverage` and `partial-recency-coverage`, and the captured evaluation time required by pure evaluator input. Extend the existing play bucket/track summary in one traversal with newest timestamp, timestamp sample count, and played-row omissions; add `lookupArtistLastViewedAt` that reuses current sentinel and ambiguous-name poisonings. Prove newest-wins, tolerated zero-play omissions, partial played evidence, all-missing evidence, and existing poisoning precedence.

### Phase 3: Engine and Evidence Integration

#### Task 3.1: Resolve config and thread the captured evaluation instant Depends on [1.2, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-shared.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/bridge/policy-rule-shared.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.test.ts`

Register the exact recency config path, resolve absent configuration to `null`, echo configured values in the v3 report, and pass the run's single `evaluatedAt` into `PolicyEvaluationInput`. Reuse the one precomputed track summary for play and recency lookup inputs. Test the null/configured resolution, v3 envelope, and pinned evaluation timestamp. Do not add another clock call or change the gatherer/action boundary.

#### Task 3.2: Admit stable recency evidence in fingerprinting Depends on [2.2]

**READ THESE BEFORE TASK**

- `docs/plans/issue-314-plex-recency-signals/design.md`
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.test.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.test.ts`

Extend the closed comparator and observation-gap registries for the new vocabulary while keeping `POLICY_EVIDENCE_FINGERPRINT_SCHEMA` at v1 and leaving the canonical projection structurally unchanged. Use proposal fixtures with stable ISO timestamp observation plus integer day bound to prove accepted canonicalization and that timestamp or threshold changes rotate the fingerprint. Preserve existing golden hashes for proposals that do not contain recency evidence.

### Phase 4: Decision and Explain Behavior

#### Task 4.1: Add the fail-closed recency conjunct to the stale rule Depends on [3.1, 3.2]

**READ THESE BEFORE TASK**

- `docs/plans/issue-314-plex-recency-signals/design.md`
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-rules.test.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-rules.test.ts`

When the resolved threshold is nonnull, require trustworthy latest-view evidence after all existing monitoring, identity, rating, acquisition, coverage, and lifetime-play gates. Compare inclusively at the captured evaluation instant using 86,400-second days; recent, future, missing, or partial data must not propose. Emit a stable `older-than-days` check with ISO timestamp, configured bound, and exact config path, plus the raw numeric observation and a human summary that may include computed age. Pin tests at one instant for exact-boundary, just-recent, old, future, missing, partial, and legacy-null behavior, and prove time passage alone does not rotate an unchanged qualifying proposal fingerprint.

#### Task 4.2: Expose the resolved threshold and explain evidence Depends on [4.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts`
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts`

Add configured `minDaysSinceLastViewed` to the threshold footer and keep generic observation/check rendering authoritative for human, JSON/YAML, and CSV paths. Update only fixtures affected by v3/3 or the new check vocabulary. Assert the readable ISO observation, `older-than-days` comparator, exact config path, resolved threshold, and visible missing/partial refusal details without creating a separate presentation path.

### Phase 5: Documentation and Roadmap Parity

#### Task 5.1: Update public policy behavior documentation Depends on [4.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-314-plex-recency-signals/design.md`
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`
- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`
- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`
- `packages/rfmedia-cli/README.md`

Replace absolute-only caveats with explicit legacy versus opt-in recency behavior. Document the 1..36,500 bound, `maxPlays` conjunction, normalized-name join, never-viewed and partial-evidence refusals, account scope, explain evidence, and stable-override behavior. Keep all repeated configuration tables and examples consistent.

#### Task 5.2: Add the discoverable configuration example Depends on [4.1]

**READ THESE BEFORE TASK**

- `rfmedia.example.yaml`

**Instructions**

Files to Modify

- `rfmedia.example.yaml`

Add a minimal valid policy example containing the recency key, its bound, and its interaction with
`maxPlays`. Keep the example free of secrets and validate it through the existing configuration
tests. Delivery records remain PR-number-dependent and are handled after the draft PR exists.

### Phase 6: Verification and Scope Audit

#### Task 6.1: Run focused and repository validation Depends on [2.1, 4.2, 5.1, 5.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/CLAUDE.md`
- `package.json`
- `packages/rfmedia-cli/package.json`
- `.github/workflows/rfmedia-cli.yml`
- `lefthook.yml`
- `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Run focused Vitest files for wire/mapper/query, config, signals, rule, engine, override, and command contracts under Node 22 before package-wide validation. Then run the package typecheck/build/test or coverage gates, architecture/codegen checks serially, repository lint/format/Markdown/whitespace checks, the Bash/Zsh/Fish completion parity test, and the real pre-push hook without bypasses. Run `graphify update .` after source changes and inspect the final diff for accidental edits to database, timeline, filter/pushdown, MCP, plan-operation, gatherer, CLI-option, or completion-template surfaces.

Record exact commands and results for the PR. Confirm the gatherer, command options, and Bash/Zsh/Fish
templates have no diff and the completion parity test remains green.

### Phase 7: Review, PR, CI, Merge, and Cleanup

#### Task 7.1: Commit, push, and open the templated draft PR Depends on [6.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/issue-314-plex-recency-signals/requirements.md`
- `docs/plans/issue-314-plex-recency-signals/design.md`

**Instructions**

Commit the complete reviewed local implementation on `feat/issue-314-plex-recency-signals` with an
intentional conventional message, run the real pre-push hook, push to the GitHub-hosting upstream,
and open a draft PR against the repository default branch. Use the PR template exactly, include
exact pass/fail commands in `## Testing`, document risk and rollback, and use `Closes #314`. Capture
the authoritative PR number and active head SHA for all subsequent delivery tasks.

#### Task 7.2: Add PR-numbered ROADMAP and archive parity Depends on [7.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/roadmap-archive.md`
- `.github/pull_request_template.md`

**Instructions**

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`

Use the real PR number to record #314 delivery, mark Sprint 1 complete, remove living-roadmap claims
that recency is unavailable, and keep #210 open for longitudinal analytics. Preserve historical
statements that accurately describe older releases. Format, lint, commit, push, and update the PR
body/testing evidence if the head SHA changes.

#### Task 7.3: Review the PR and fix every actionable finding Depends on [7.2]

**READ THESE BEFORE TASK**

- `docs/plans/issue-314-plex-recency-signals/design.md`
- `.github/pull_request_template.md`
- `packages/rfmedia-cli/CLAUDE.md`

**Instructions**

Run the repository's proper PR code-review workflow against the active PR head and persist its review
artifact under `docs/prps/reviews/` when the workflow requires it. Classify every finding against the
issue acceptance criteria, apply all actionable fixes through the review-fix workflow, and rerun the
affected focused tests plus every invalidated package/repository gate. Commit and push the review
artifact and fixes, resolve actionable GitHub review threads, and repeat review until no required
finding remains.

#### Task 7.4: Reach green CI, squash merge, and clean up Depends on [7.3]

**READ THESE BEFORE TASK**

- `.github/workflows/rfmedia-cli.yml`
- `lefthook.yml`
- `ROADMAP.md`

**Instructions**

Monitor registered checks for the active head SHA. If CI fails, inspect the authoritative GitHub
Actions logs, fix the root cause without bypassing hooks, rerun invalidated local gates, push, and
restart monitoring on the new head. Require every registered check green and every actionable review
thread resolved, then mark the PR ready if needed and squash merge it. Verify the PR's merge commit,
issue #314 closure, remote feature-branch absence, final `master` alignment, ROADMAP/archive parity,
and clean repository state. Remove only the dedicated feature worktree and local/remote feature
branches after authoritative merge evidence; preserve the primary checkout and unrelated worktrees.

## Advice

- Do not default `lastViewedAt`; timestamp absence is the core safety signal this issue adds.
- A zero-play row may omit recency, but a played row without recency poisons the artist aggregate even when other rows have timestamps.
- Keep `minDaysSinceLastViewed` conjunctive with `maxPlays`; users must raise the lifetime ceiling deliberately for previously played artists.
- Store raw timestamp and configured days as evidence. Computed age belongs only in non-fingerprinted prose, so clock passage cannot churn suppressions.
- Reuse the existing complete track drain and normalized-name poison set; a second request or join can create inconsistent evidence.
- No CLI token changes means no Bash/Zsh/Fish edits. Still run and report the existing parity audit.
- Keep issue #210 open: this domain field is reusable plumbing, not timeline persistence or analysis.
- Run generated Lidarr and architecture gates serially under the repository's Node 22 runtime.
