# File-Aware Lidarr Artist Delete

Issue #200 extends the existing strict `rfmedia.lidarr-plan.v2` workflow with one additive,
artist-only `artist-delete` operation. Planning reuses deterministic artist selection, seals
Lidarr-reported path and file-impact evidence, and defaults to keeping files; apply layers
independent destructive authorizations over whole-plan and just-in-time drift checks, durable
possible-dispatch history, single-ID deletion, and typed absence verification. Artist deletion is
never automatically retried or deferred, while an optional full Plex scan remains a best-effort
apply-time follow-up outside the immutable plan and history.

## Relevant Files

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Closed v2 deletion and history contracts.
- `packages/rfmedia-cli/src/types/lidarr.ts`: Optional artist path and statistics projection.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole handwritten generated-client facade.
- `packages/rfmedia-cli/src/lib/lidarr/errors.ts`: Typed authoritative not-found classification.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Read retry wrapper and mutation forwarding.
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`: Deterministic bounded artist selector.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: V2 operation behavior registry.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Strict parsing, checksums, history, and claims.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`: Closest filtered v2 planning pattern.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts`: Closest operation-specific planning pattern.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Whole-plan authorization and apply orchestration.
- `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`: Just-in-time target admission.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-entry-execution.ts`: Dispatch reconciliation boundary.
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`: Sequential stop-admission loop.
- `packages/rfmedia-cli/src/actions/lidarr/apply-deferred-replay.ts`: Resume replay exclusion boundary.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Commander hierarchy and option forwarding.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Review, prompt, result, and recovery output.
- `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts`: Optional provider-neutral scan resolver.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Three-shell parity tests.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Generated-client and transport architecture gate.

## Relevant Patterns

**Private generated facade**: Only
[`packages/rfmedia-cli/src/lib/lidarr/client.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/client.ts)
may import the generated Lidarr SDK; upper layers consume `LidarrClientApi`.

**Strict operation registry**: Each v2 operation owns construction, canonicalization, drift
classification, execution, verification, and deferability in
[`packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts).

**Two-stage admission**: Whole-plan preflight in
[`packages/rfmedia-cli/src/actions/lidarr/apply.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/apply.ts)
is followed by a targeted read immediately before each mutation in
[`packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts).

**Durable attributable outcomes**: Exclusive plan claims and private JSONL history in
[`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts)
bind recovery evidence to the plan, checksum, entry, and idempotency key.

**Provider-neutral follow-up**: Apply resolves optional scan support through
[`packages/rfmedia-cli/src/lib/adapters/action-helpers.ts`](../../../packages/rfmedia-cli/src/lib/adapters/action-helpers.ts)
without putting Plex intent into Lidarr artifacts.

## Relevant Docs

**`docs/plans/file-aware-lidarr-artist-delete/feature-spec.md`**: You _must_ read this when
implementing any issue #200 behavior; it supersedes alternatives in individual research files.

**`packages/rfmedia-cli/AGENTS.md`**: You _must_ read this when changing the package architecture,
TypeScript, tests, or command surface.

**`packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`**: You _must_ read this when changing
plan, apply, history, resume, or operator recovery behavior.

**`packages/rfmedia-cli/README.md`**: You _must_ read this when adding public commands or examples.

**`packages/rfmedia-cli/docs/features/shell-completion.doc.md`**: You _must_ read this when
changing command or option completion behavior.

**`ROADMAP.md`**: You _must_ read this when closing #200 while preserving #223 album ownership.
