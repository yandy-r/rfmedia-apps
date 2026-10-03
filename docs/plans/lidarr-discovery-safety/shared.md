# Lidarr Discovery Safety

The discovery safety feature extends the shipped Last.fm provider, framework-independent discovery
action, and `lidarr discover` command with deterministic policy evaluation before any candidate can
reach the existing plan/apply boundary. A pure discovery policy module will own thresholds,
MBID-first visited identity, bounded breadth-first admission, exposure-aware re-ranking, and
invocation-scoped quarantine decisions, while the action retains scheduler/provider orchestration
and the command retains parsing and presentation. Explicit rank selection may approve multiple
candidates into one bounded sealed `artist-add` plan, but only the existing separately reviewed
`lidarr apply` workflow may mutate Lidarr. The safe default remains an attributed, one-hop,
read-only preview with no Lidarr resolution, plan write, prompt, or persistent quarantine state.

## Relevant Files

- `packages/rfmedia-cli/src/types/discovery.ts`: Public safety, traversal, decision, and result contracts
- `packages/rfmedia-cli/src/lib/discovery/policy.ts`: New pure bounds, identity, policy, and ranking module
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`: Fixed-origin provider and available scoring evidence
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`: Traversal, scheduler, policy, and plan-handoff orchestration
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`: Public option grammar, approval selection, and rendering
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`: Exact-MBID artist-add plan construction
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Sealed multi-entry artist-add plan contract
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Plan validation, checksum, and batch invariants
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`: Multi-entry artist-add apply orchestration
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Review presentation for approved entries
- `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`: Critical traversal and no-mutation action contracts
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`: CLI grammar, forwarding, output, and approval contracts
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Bash/Zsh/Fish discover-option parity
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Bash discover completion template
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Zsh discover completion template
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Fish discover completion template
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`: Canonical operator safety contract
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Separate mutation approval contract
- `packages/rfmedia-cli/README.md`: Public command examples and scope
- `packages/rfmedia-cli/CHANGELOG.md`: Unreleased discovery safety record
- `ROADMAP.md`: Live issue inventory and Layer 2 sequencing
- `docs/roadmap-archive.md`: Completed issue and PR record

## Relevant Patterns

**Generated-independent contracts**: Public discovery and plan types remain immutable and never
import the private generated Lidarr SDK. See
[`packages/rfmedia-cli/src/types/discovery.ts`](../../../packages/rfmedia-cli/src/types/discovery.ts).

**Pure policy, impure orchestration**: Deterministic admission and ranking belong in a side-effect
free library; provider scheduling and handoff stay in the action. See
[`packages/rfmedia-cli/src/actions/lidarr/discover.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/discover.ts).

**Provider isolation**: Last.fm owns one fixed-origin, strictly validated request and no retry
loop; scheduler policy owns retry, cancellation, concurrency, and budgets. See
[`packages/rfmedia-cli/src/lib/discovery/lastfm.ts`](../../../packages/rfmedia-cli/src/lib/discovery/lastfm.ts).

**Preview then sealed intent then apply**: Candidate approval writes reviewable intent rather than
dispatching a mutation; a later apply independently reviews, confirms, revalidates, and records the
operation. See
[`packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`](../../../packages/rfmedia-cli/docs/features/lidarr-plan-apply.md).

**MBID-first safety identity**: Canonical MBID is authoritative for loop prevention and mutation
eligibility, with a provider-scoped normalized-name fallback allowed only for preview membership.
See
[`packages/rfmedia-cli/src/actions/lidarr/discover.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/discover.ts).

**Fail-closed grammar and runtime validation**: Commander rejects malformed values and option
relationships before lazy loading, while the action and policy revalidate plain runtime inputs
before provider, scheduler, Lidarr, or filesystem work. See
[`packages/rfmedia-cli/src/commands/lidarr-discover.ts`](../../../packages/rfmedia-cli/src/commands/lidarr-discover.ts).

**Static completion parity**: Bash, Zsh, and Fish expose the same ordered options and value
semantics without loading configuration or performing network work. See
[`packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`](../../../packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts).

## Relevant Docs

**`docs/plans/lidarr-discovery-safety/design.md`**: You _must_ read this for the resolved CLI,
policy, traversal, quarantine, ranking, and acceptance contracts.

**`packages/rfmedia-cli/docs/features/lidarr-discovery.md`**: You _must_ read this when changing
the operator workflow, output schema, or Last.fm/Lidarr separation.

**`packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`**: You _must_ read this when widening
artist-add plans or preserving the separate mutation approval gate.

**`packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`**: You _must_ read this when
implementing deep traversal, invocation-wide budgets, retries, or cancellation.

**`docs/plans/lidarr-similar-artist-discovery/feature-spec.md`**: You _must_ read this for the
shipped #203 contract and the safety scope it deliberately deferred to #205.

**`packages/rfmedia-cli/docs/features/shell-completion.doc.md`**: You _must_ read this when adding
or classifying public discover options across shells.

**`packages/rfmedia-cli/AGENTS.md`**: You _must_ read this for package architecture, strict
TypeScript, tests, documentation, and validation commands.

**`.github/pull_request_template.md`**: Reference for the required delivery evidence and issue
closure wording.
