# Lidarr Policy Plan

Issue #311 adds an orchestration path between the shipped read-only policy evaluator and the
existing strict-v3 Lidarr plan producers. The new command runs evaluation once, projects every
proposal through a pure total bridge, and defaults to an artifact-free review; explicit plan mode
may seal only after the complete selected scope is projectable. Existing producers retain fresh
state, checksum, path, and artifact ownership, while apply remains a separate pinned command.

## Relevant Files

- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: Existing proposal, handoff, and producer vocabularies.
- `packages/rfmedia-cli/src/types/index.ts`: Public type and constant barrel.
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts`: Pure projection and refusal precedent.
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`: Unchanged live evidence action.
- `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`: Closest orchestration and partial-output precedent.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`: Existing profile plan producer.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`: Existing monitoring plan producer.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: Lazy command-facing action barrel.
- `packages/rfmedia-cli/src/commands/lidarr-policy.ts`: Existing parent and evaluate leaf.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: Human and machine policy output owner.
- `packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts`: Multi-cohort/refusal presentation precedent.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Bash nested routing template.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Zsh nested routing template.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Fish nested routing template.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Cross-shell parity contract.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: Primary operator guide to update.
- `packages/rfmedia-cli/README.md`: Package command reference to update.
- `ROADMAP.md`: Live issue state and Sprint 2 follow-up source.

## Relevant Patterns

**Command, Action, Pure Library Separation**: Commander validates and renders, actions own I/O, and
bridge modules stay deterministic; see
[`lidarr-policy.ts`](../../../packages/rfmedia-cli/src/commands/lidarr-policy.ts),
[`policy-evaluate.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts), and
[`rating-sync.ts`](../../../packages/rfmedia-cli/src/lib/bridge/rating-sync.ts).

**Closed Discriminated Routing**: `as const` vocabularies, derived unions, and total `Record` maps
make new producers compile-time incomplete until handled; see
[`lidarr-policy.ts`](../../../packages/rfmedia-cli/src/types/lidarr-policy.ts).

**Evidence Is Not Authority**: Evaluation proposes from Plex/Lidarr evidence, while the unchanged
producers re-read live Lidarr state before constructing an artifact; see
[`plan-artist-profiles.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts)
and [`plan.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/plan.ts).

**Review-First Safety Ladder**: Default recommend mode writes nothing, explicit plan mode seals, and
apply remains separately authorized; see
[`sync-ratings.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts).

**Static Completion Parity**: Bash, Zsh, and Fish are independent handwritten surfaces locked to
shared option constants by
[`templates.spec.ts`](../../../packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts).

## Relevant Docs

**docs/plans/issue-311-policy-plan/feature-spec.md**: You _must_ read this for the fixed v1 syntax,
global refusal gate, result states, and non-goals.

**packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md**: You _must_ read §§2.1, 2.2,
7.2, and 15 for the evaluation, inert-handoff, and plan-schema boundaries.

**packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md**: You _must_ read this when
changing policy semantics, examples, output, or troubleshooting.

**packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md**: You _must_ read this for the closest
recommend/plan orchestration, refusal, and ordered partial-output precedent.

**packages/rfmedia-cli/docs/features/lidarr-plan-apply.md**: You _must_ read this for strict v3
artifacts, checksum pinning, fresh-state validation, and the separate apply boundary.

**packages/rfmedia-cli/docs/features/shell-completion.doc.md**: You _must_ read this when updating
nested Bash, Zsh, and Fish command/options/value parity.
