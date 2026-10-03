# Lidarr Safe Artist-Add Guardrails

Issue #206 extends the existing `lidarr discover --add` workflow rather than adding a second mutation path: discovery produces a sealed artist-add plan, and generic apply owns all Lidarr writes. The feature turns the current hard-coded unmonitored behavior into an omitted-safe default with one explicit monitored override, resolves an albums-only metadata profile from structural server evidence, and seals optional post-add album-type unmonitoring into the reviewed artifact. Apply must preserve the one-artist-POST invariant while making album normalization a distinct, verified, resumable stage.

## Relevant Files

- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`: Public discover-add grammar and option validation.
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`: Connects approved discovery results to plan creation.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`: Resolves resources and builds sealed add plans.
- `packages/rfmedia-cli/src/types/lidarr.ts`: Stable generated-independent Lidarr domain contracts.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Immutable plan, history, and result schemas.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Strict response projection boundary for generated DTOs.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole handwritten Lidarr transport facade.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: Policy, risk, and idempotency definitions.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Exact plan parsing, checksums, history, and resume selection.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`: Non-idempotent create and reconciliation boundary.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`: Plan-wide admission, resume, and outcome orchestration.
- `packages/rfmedia-cli/src/lib/lidarr/album-types.ts`: Closed album-type selector vocabulary and matching.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Bash completion source for public options.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Zsh completion source for public options.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Fish completion source for public options.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Generated-client and mutation-owner architecture gate.

## Relevant Patterns

**Sealed plan/apply mutation**: Resolve every default and selector before checksum sealing, then apply only reviewed intent. See [`packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts).

**Durable possible-dispatch recovery**: Persist ambiguity before the non-idempotent POST and reconcile by exact MusicBrainz ID. See [`packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts).

**Generated-independent facade**: Project unknown generated responses into frozen stable types before returning them upward. See [`packages/rfmedia-cli/src/lib/lidarr/types.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/types.ts).

**Closed selector matching**: Parse and canonicalize only supported album types, then filter artist-scoped album results locally. See [`packages/rfmedia-cli/src/lib/lidarr/album-types.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/album-types.ts).

**Completion parity**: Treat Bash, Zsh, and Fish templates as one public CLI contract. See [`packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`](../../../packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts).

## Relevant Docs

**`packages/rfmedia-cli/docs/features/lidarr-discovery.md`**: You _must_ read this when changing discovery approval or add-plan handoff.

**`packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`**: You _must_ read this when changing plan sealing, apply, history, or resume behavior.

**`packages/rfmedia-cli/docs/features/lidarr-generated-client.md`**: You _must_ read this when changing facade projections or generated operation contracts.

**`packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`**: You _must_ read this when changing mutation ownership or recovery stages.

**`packages/rfmedia-cli/docs/features/shell-completion.doc.md`**: You _must_ read this when changing public CLI options or completion parity.
