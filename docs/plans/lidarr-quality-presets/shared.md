# Lidarr Quality Preset Packs

The rfmedia CLI separates Commander presentation, framework-independent actions, pure Lidarr
domain logic, a handwritten client facade, and a private generated SDK. Issue #213 adds a dedicated
`lidarr presets list|show|diff|apply` path through those layers, with strict local built-ins/config,
fresh semantic comparison, and sequential verified convergence. Rich global configuration
definitions remain separate from the sealed numeric artist/album plan family, while a new
canonical-origin filesystem lock and journal reuse its hardened storage principles. The change also
touches configuration, machine/human output, architecture gates, all shell completions, operator
documentation, changelog, and roadmap surfaces.

## Relevant Files

- `docs/plans/lidarr-quality-presets/feature-spec.md`: Frozen product, safety, data, and UX contract.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Lidarr namespace and preset-subtree registration.
- `packages/rfmedia-cli/src/commands/lidarr-search.ts`: Extracted subtree and output dependency-injection pattern.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Review, impact, and partial-outcome presentation precedent.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: Public action barrel for new entrypoints.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Approval, interruption, claim, and durable outcome precedent.
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`: Sequential stop-admission apply pattern.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`: Typed facade mock seam.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Stable facade and sole generated-SDK importer.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Bounded unknown-to-domain projector boundary.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts`: Sole authenticated Fetch and origin-security owner.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`: Canonical origin, client, and scheduler resolution.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Explicit safe-read retry classification and wrapper.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Bounded read and serial destructive execution lanes.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Hardened owner-only atomic storage and claim precedent.
- `packages/rfmedia-cli/src/types/config.ts`: Typed optional `lidarr.profilePresets` integration.
- `packages/rfmedia-cli/src/lib/config.ts`: Bounded YAML parsing and nested validation.
- `packages/rfmedia-cli/src/lib/formatters/index.ts`: Machine serialization and CSV formula neutralization.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Bash/Zsh/Fish command parity contract.
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`: Committed endpoint and wire-shape guard.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Generated-import and Fetch-owner architecture gate.
- `rfmedia.example.yaml`: Secret-free configured-pack example surface.
- `packages/rfmedia-cli/README.md`: Primary rfmedia command reference.
- `packages/rfmedia-cli/CHANGELOG.md`: Unreleased feature entry.
- `ROADMAP.md`: Open issue tracking and sprint state.
- `docs/roadmap-archive.md`: Post-merge shipped-work record.

## Relevant Patterns

**Command Factory with Dependency Injection**: Large Lidarr subtrees stay cycle-free and lazy. See
[packages/rfmedia-cli/src/commands/lidarr-search.ts](../../../packages/rfmedia-cli/src/commands/lidarr-search.ts).

**Framework-Independent Scheduled Action**: Actions validate before resolving clients and declare
execution metadata explicitly. See
[packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts](../../../packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts).

**Private Generated Facade**: Generated operations remain in the facade and all Fetch remains in
the transport. See
[packages/rfmedia-cli/src/lib/lidarr/client.ts](../../../packages/rfmedia-cli/src/lib/lidarr/client.ts)
and
[packages/rfmedia-cli/src/lib/lidarr/transport.ts](../../../packages/rfmedia-cli/src/lib/lidarr/transport.ts).

**Frozen Bounded Projection**: Whole wire responses are validated, copied, and frozen before use.
See
[packages/rfmedia-cli/src/lib/lidarr/types.ts](../../../packages/rfmedia-cli/src/lib/lidarr/types.ts).

**Review-First Sequential Convergence**: Full preflight precedes ordered writes, read-back, durable
outcomes, and stop admission. See
[packages/rfmedia-cli/src/actions/lidarr/apply.ts](../../../packages/rfmedia-cli/src/actions/lidarr/apply.ts).

**Owner-Only Atomic State**: Claims and history validate ownership, paths, identity, permissions,
and atomic publication. See
[packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts](../../../packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts).

**Human/Machine Stream Separation**: Human tables use stderr while one versioned machine document
uses stdout. See
[packages/rfmedia-cli/src/commands/lidarr-search.ts](../../../packages/rfmedia-cli/src/commands/lidarr-search.ts).

**Static Completion Parity**: Bash, Zsh, and Fish templates are maintained explicitly and remain
offline. See
[packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts](../../../packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts).

## Relevant Docs

**docs/plans/lidarr-quality-presets/feature-spec.md**: You _must_ read this before changing scope,
ownership, output, or apply behavior.

**packages/rfmedia-cli/docs/features/lidarr-generated-client.md**: You _must_ read this before
changing facade methods, generated operations, or architecture gates.

**packages/rfmedia-cli/docs/features/lidarr-plan-apply.md**: You _must_ read this before implementing
review, drift, partial outcome, interruption, or recovery behavior.

**packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md**: You _must_ read this before
classifying scheduler work or retries.

**docs/features/shell-completion.md**: You _must_ read this before changing the command surface or
completion templates.

**packages/rfmedia-cli/README.md**: You _must_ read this before adding public commands or examples.

**ROADMAP.md** and **docs/roadmap-archive.md**: You _must_ read these before marking issue #213
delivered.
