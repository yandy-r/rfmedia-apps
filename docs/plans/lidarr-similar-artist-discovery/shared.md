# Lidarr Similar Artist Discovery

Issue #203 adds a Last.fm-first `rfmedia lidarr discover` read path and an optional,
strictly separate handoff that writes one sealed `artist-add` plan. Ordinary discovery uses the
existing `discovery` scheduler lane and a new fixed-origin Last.fm transport without resolving
Lidarr, touching the Lidarr cache, or persisting provider data. The add handoff requires an
MBID-backed visible result and fresh Lidarr identity/resource reads, while `lidarr apply` remains
the only mutation boundary and reconciles a possibly dispatched create by exact MBID. Generated
Lidarr source remains private and unchanged; Bash, Zsh, and Fish expose one identical static
command contract.

## Relevant Files

- `packages/rfmedia-cli/src/commands/lidarr-search.ts`: Closest sibling command and output pattern.
- `packages/rfmedia-cli/src/actions/lidarr/search.ts`: Closest scheduled read-action pattern.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Discovery lane, retry, cancellation, metadata.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole generated-client facade and DTO boundary.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Exhaustive facade wrapper and retry policy.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Closed plan, entry, history, and result unions.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Strict artifacts, checksums, history, claims.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: Mutation operation registry.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Apply preflight, dispatch, resume, reconciliation.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Plan/apply text and CSV rendering.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Fetch and mutation ownership gate.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Cross-shell parity contract.

## Relevant Patterns

**Sibling command factory**: Inject parent-owned output and failure helpers without creating an
ESM cycle. See
[`packages/rfmedia-cli/src/commands/lidarr-search.ts`](../../../packages/rfmedia-cli/src/commands/lidarr-search.ts).

**Strict external projection**: Accept unknown wire values, validate the complete bounded
collection, and return generated-independent frozen values. See
[`packages/rfmedia-cli/src/lib/lidarr/types.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/types.ts).

**Scheduler-owned retry**: Submit idempotency and lane metadata once; transports never add their
own retry loop. See
[`packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/scheduler.ts).

**Sealed plan/apply mutation**: Bind exact origin, operation, resources, expected/desired state,
checksum, history, and claim before mutation. See
[`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts).

**Possible-dispatch reconciliation**: Persist evidence before a non-idempotent request, then prove
the postcondition with an authoritative read rather than retrying. See
[`packages/rfmedia-cli/src/actions/lidarr/apply-artist-entry-execution.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/apply-artist-entry-execution.ts).

## Relevant Docs

**`docs/plans/lidarr-similar-artist-discovery/feature-spec.md`**: You _must_ read this for the
authoritative issue #203 behavior, scope, security, output, and release contracts.

**`packages/rfmedia-cli/docs/features/lidarr-search-lookup.md`**: You _must_ read this when
implementing ranked discovery output and command presentation.

**`packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`**: You _must_ read this when
changing scheduler failure classification, retries, or cancellation.

**`packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`**: You _must_ read this when adding
`artist-add`, expected-absence preflight, history, resume, or uncertainty behavior.

**`packages/rfmedia-cli/docs/features/lidarr-generated-client.md`**: You _must_ read this when
using root-folder or artist-create generated operations.

**`packages/rfmedia-cli/AGENTS.md`**: You _must_ read this before changing rfmedia-cli source,
tests, generated contracts, or public documentation.
