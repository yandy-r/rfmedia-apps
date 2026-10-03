# Lidarr Artist Bulk Profile and Tag Management

Issue #199 extends the existing Lidarr sealed plan/apply architecture with separate
`artist-profiles` and `artist-tags` plan producers while keeping `lidarr apply` as the only remote
write path. Planning resolves fresh complete artist and resource snapshots, freezes exact targets,
and writes a strict version 2 plan; apply preserves the current origin, checksum, approval, claim,
history, deferred-intent, cancellation, and resume boundaries while adding targeted stale checks
and verified postconditions. Existing version 1 monitoring plans remain byte- and checksum-stable
for read, apply, history, and resume, while every current producer moves to version 2. Generated
operations and allowlisted editor bodies stay private to the stable client facade, and all
profile/tag work remains in the `local-only` execution lane.

## Relevant Files

- `packages/rfmedia-cli/src/commands/lidarr.ts`: Registers plan leaves, parses options, approves,
  renders, and controls exit behavior.
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`: Covers hierarchy, option forwarding,
  approval, machine output, and exits.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`: Existing fresh monitoring-plan producer and
  artifact-write orchestration pattern.
- `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`: Planning tests for selection, caps,
  no-ops, and artifact output.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Generic preflight, claim, mutation, history,
  deferred, cancellation, and resume lifecycle.
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`: Lifecycle regression surface for drift,
  uncertainty, durability, and resume.
- `packages/rfmedia-cli/src/actions/lidarr/list.ts`: Existing AND and repeated-tag all-of predicate
  semantics; paging/stale behavior is not reusable.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: Public action exports for the new plan
  producers.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`: Typed facade mock that
  must grow with `LidarrClientApi`.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-fixtures.ts`: Domain fixtures for artists,
  profiles, and tags.
- `packages/rfmedia-cli/src/types/lidarr.ts`: Stable generated-independent artist and resource
  domain types.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Versioned plan, entry, stale, history, and apply
  result contracts.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Strict unknown-to-domain resource projection and
  tag normalization.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole generated-operation importer and narrow
  artist editor facade.
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`: Exact generated operation, body,
  projection, cancellation, and secret-isolation tests.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Explicit facade delegation and read
  retry/cache policy.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`: Delegation, retry allowlist, and
  no-retry mutation tests.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Strict schemas, checksums, operation
  registry, artifacts, history, resume, and claims.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: Version compatibility, sealing,
  parsing, persistence, and operation invariant tests.
- `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts`: Exact deferred intent validation,
  replay, and executor registry.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Shared `local-only` admission and retry
  metadata.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts`: Sole authenticated Fetch owner and origin/key
  security boundary.
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`: Private generated operations already
  covering all required Lidarr endpoints.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`: Offline required-operation and drift
  contract.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Generated-import, endpoint,
  mutation-owner, and Fetch architecture audit.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Bash static command and option surface.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Zsh static command and option surface.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Fish static command and option surface.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Cross-shell hierarchy and
  option parity gate.
- `packages/rfmedia-cli/README.md`: User-facing command examples and plan/apply guidance.
- `packages/rfmedia-cli/CHANGELOG.md`: Unreleased operator-visible command and safety changes.
- `ROADMAP.md`: Open-work status that must mark #199 shipped only with real merge evidence.
- `docs/roadmap-archive.md`: Historical shipped detail after the PR number is known.

## Relevant Tables

- `lidarr_deferred_intents`: Existing schema-v10 generic operation/payload/idempotency queue used
  for exact explicit resume; no migration is required.

Plan artifacts, claims, and history remain private filesystem state rather than database tables:
plans under the configured plan directory, compacted JSONL history under `lidarr-history`, and
exclusive claim files under `lidarr-claims`.

## Relevant Patterns

**Command/action separation**: Commands own Commander grammar, lazy imports, rendering, approval,
and exit status; actions return typed results without printing. Follow
[`commands/lidarr.ts`](packages/rfmedia-cli/src/commands/lidarr.ts) and
[`actions/lidarr/plan.ts`](packages/rfmedia-cli/src/actions/lidarr/plan.ts).

**Stable facade over private generated code**: Only the handwritten client imports generated
operations, and only the transport owns authenticated Fetch. Follow
[`client.ts`](packages/rfmedia-cli/src/lib/lidarr/client.ts) and
[`transport.ts`](packages/rfmedia-cli/src/lib/lidarr/transport.ts).

**Strict projection at the wire boundary**: Generated types do not provide runtime trust. Project
complete unknown responses into bounded immutable domain values using
[`types.ts`](packages/rfmedia-cli/src/lib/lidarr/types.ts).

**Explicit resilience delegation**: Every facade method is forwarded explicitly; safe reads may be
retryable while mutations are not retried in place. Follow
[`resilience.ts`](packages/rfmedia-cli/src/lib/lidarr/resilience.ts).

**Pure mutation selection**: Resolve exact IDs or names, AND/all-of filters, complete cohorts,
deterministic order, zero matches, and caps in a pure helper. Reuse predicate semantics from
[`list.ts`](packages/rfmedia-cli/src/actions/lidarr/list.ts), never its paging or stale cache.

**Versioned sealed artifacts**: Preserve the exact v1 parser and checksum while adding a strict v2
discriminated union and version dispatch. Follow the existing canonicalization and safe I/O in
[`plan-engine.ts`](packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts).

**Operation-owned semantics**: Each operation definition owns canonical state, risk, entry
construction, idempotency, classification, execution, verification, deferred payload validation,
and replay matching; artifact infrastructure stays operation-neutral.

**Per-target durable apply**: Preflight the whole plan, revalidate one artist immediately before a
write, call the editor with one ID, verify with a targeted read, and persist the authoritative
outcome before admitting the next artist. Extend
[`apply.ts`](packages/rfmedia-cli/src/actions/lidarr/apply.ts).

**Exact resume identity**: Deferred replay exact-matches origin, operation, normalized payload, and
idempotency key before live reconciliation. Reuse
[`deferred-queue.ts`](packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts).

**Typed tests at owning layers**: Pure semantics use table-driven tests; actions mock only the typed
facade; client tests assert exact generated requests; lifecycle tests focus on state transitions.
Use `vi.clearAllMocks()` and the helpers in
[`lidarr-client-mocks.ts`](packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts).

**Static completion parity**: Update Bash, Zsh, and Fish together and lock the exact hierarchy,
flags, and value candidates in
[`templates.spec.ts`](packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts).

**Architecture as executable policy**: Extend the existing audit without weakening its private
generated imports, handwritten endpoint, or exactly-one-Fetch rules. Follow
[`check-direct-plex-imports.mjs`](packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs).

## Relevant Docs

**`docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`**: You _must_ read this before any
implementation task; it is the settled product and safety contract.

**`docs/plans/199-lidarr-artist-bulk-management/research-recommendations.md`**: You _must_ read this
when deciding command shape, selection, v2 compatibility, tag modes, verification, or task order.

**`packages/rfmedia-cli/AGENTS.md`**: You _must_ read this before changing package code, tests,
imports, command structure, or documentation.

**`packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`**: You _must_ read this when changing
plans, apply, dry-run, approval, history, claims, deferred work, or resume.

**`packages/rfmedia-cli/docs/features/lidarr-generated-client.md`**: You _must_ read this when
changing generated contracts, facade methods, transport, codegen, or architecture gates.

**`packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`**: You _must_ read this when
changing scheduler metadata, retry ownership, cancellation, or mutation admission.

**`packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`**: You _must_ read this when extending
required generated operation checks; normal implementation must not refresh the snapshot.

**`packages/rfmedia-cli/README.md`**: You _must_ update this for the new command surface and
operator workflow.

**`packages/rfmedia-cli/CHANGELOG.md`**: You _must_ update `[Unreleased]` with the new commands and
safety behavior without claiming a release.

**`.github/pull_request_template.md`**: You _must_ use this exact section structure for the final
issue-closing PR and include exact validation outcomes.

**`ROADMAP.md` and `docs/roadmap-archive.md`**: You _must_ update these only with verified issue and
PR lifecycle evidence. Final shipped wording may be staged transactionally in the real
issue-closing PR after GitHub assigns its number, but it becomes current only when that PR merges;
revert to pending wording if merge is abandoned.
