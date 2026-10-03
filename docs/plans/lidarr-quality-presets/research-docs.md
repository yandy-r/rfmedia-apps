# Documentation Research: lidarr-quality-presets

## Documentation Overview

The feature crosses the public rfmedia command reference, a dedicated Lidarr feature guide,
configuration examples, shell-completion documentation, release notes, and the repository roadmap.
The current Lidarr generated-client, execution-lane, plan/apply, search, and album documents provide
the architectural and writing precedents, but no existing document explains preset ownership,
built-in pack policy, live diff semantics, naming consequences, or partial apply recovery.

## Relevant Documentation

### README and User Guides

- `packages/rfmedia-cli/README.md` — **Required.** The authoritative rfmedia installation and
  command reference already contains Lidarr Search and Lookup, Albums, Mutation Plan/Apply,
  Execution Lanes, and Client Generation sections. Add the complete presets command surface
  (`list`, `show`, `diff`, and `apply`), examples, output behavior, approval rules, and a link to
  the detailed feature guide.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` — **Required precedent.** Documents
  review, dry-run, drift, approval, history, partial outcomes, and recovery language for existing
  Lidarr mutations. Presets are a separate desired-state workflow, so reuse safety terminology
  without claiming compatibility with `rfmedia.lidarr-plan.v2`.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` — **Required.** Defines the
  generated SDK boundary, committed snapshot/codegen policy, facade ownership, and architecture
  gates that the new quality-profile, custom-format, and naming endpoints must preserve.
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md` — **Required.** Defines scheduler
  lanes, retry rules, preflight, and machine-visible execution metadata. The feature must document
  its local-only reads/writes and the no-hot-retry mutation rule consistently.
- `packages/rfmedia-cli/docs/features/lidarr-search-lookup.md` — **Useful precedent.** Shows the
  current style for a Lidarr command subtree, stable JSON/YAML envelopes, fixed-row CSV, pagination,
  error recovery, and examples.
- `packages/rfmedia-cli/docs/features/lidarr-albums.md` — **Useful precedent.** Shows command tables,
  dry-run examples, blast-radius explanations, and cross-links between a focused Lidarr feature and
  the main README.
- `docs/features/plan-apply-workflow.md` — **Useful precedent.** Repository-level explanation of
  preview/apply safety, staleness, approvals, and audit behavior. Use it to keep terminology aligned
  while clearly identifying the presets workflow as live desired-state reconciliation.

### API and Architecture Documentation

- `packages/rfmedia-cli/src/lib/lidarr/client.ts` — **Required code documentation.** Its module and
  interface comments define the stable facade contract: generated operations own wire details,
  projectors own validation, and the transport owns origin/credential policy.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` — **Required code documentation.** Documents
  unknown-to-domain projection, bounds, sanitization, immutable copies, and private credential
  handling.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts` — **Required code documentation.** Defines the
  only authenticated Fetch owner and the redirect, timeout, response-size, origin, and error
  boundaries.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` — **Required safety precedent.** Documents
  canonicalization, owner-only atomic storage, durable history, and exclusive-claim behavior.
  Implementers may reuse or extract hardened primitives, but must not present its UUID-keyed
  artist/album plan artifacts as the preset journal or origin lock.
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json` and
  `packages/rfmedia-cli/openapi/lidarr-v1.json` — **Required API evidence.** Pin the committed Lidarr
  source and endpoint/type snapshot used for the facade; do not edit or refresh them unless a
  generated-contract test proves the committed operations are insufficient.
- `docs/plans/lidarr-quality-presets/feature-spec.md` — **Required product contract.** Freezes the
  four commands, three built-ins, additive ownership, exact pack resolution, live validation,
  output schemas, apply ordering, origin lock, journaling, and recovery semantics.
- `docs/plans/lidarr-generated-client/feature-spec.md` — **Useful architecture history.** Explains
  why generated modules stay private and why facade projections, offline codegen, and contract
  checks are required.

### Configuration and Completion Documentation

- `rfmedia.example.yaml` — **Required.** The shipped example contains the current `lidarr` URL,
  API-key, resilience, and scheduler sections. Add a commented, secret-free
  `lidarr.profilePresets` configured-pack example that demonstrates every required v1 shape without
  implying inheritance or remote catalogs.
- `docs/features/shell-completion.md` — **Required release surface.** Documents generation,
  installation, and maintenance expectations for Bash, Zsh, and Fish completions.
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md` — **Useful package precedent.**
  Provides rfmedia-specific completion examples and should remain consistent if it enumerates the
  Lidarr command surface.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` — **Required executable
  documentation.** Locks command-tree and option parity across all three shells and proves
  completion does not initialize config, a Lidarr client, a scheduler, or Fetch.

### Release and Roadmap Documentation

- `packages/rfmedia-cli/CHANGELOG.md` — **Required.** Add an Unreleased/Added entry describing the
  four commands, three built-ins, configured packs, dry-run/approval behavior, additive non-effects,
  output formats, and completion/config changes.
- `ROADMAP.md` — **Required.** Issue #213 currently appears in Sprint 1 and the open Lidarr Phase B
  table. After merge, remove it from open/current work and update Sprint exit context without
  leaving duplicate open rows.
- `docs/roadmap-archive.md` — **Required.** Follow the shipped-work archive pattern by recording
  issue #213, its squash-merged PR, delivery date, and concise outcome once the merge is verified.
- `docs/README.md` — **Nice to have.** Update only if its documentation index explicitly enumerates
  package feature guides and therefore needs a link to the new preset guide.

## Documentation Gaps/Required Updates

1. Create `packages/rfmedia-cli/docs/features/lidarr-quality-presets.md` as the detailed operator
   guide. It must cover pack references and collision handling, exact built-in policies and
   tradeoffs, configured-pack schema, same-name adoption, managed versus retained state, naming
   effects on future imports, live capability validation, complete diff fields, approval,
   dry-run/no-op behavior, ordered writes, local-only locking, journal location/security,
   partial/uncertain outcomes, safe rerun, machine schemas, and explicit non-effects.
2. Extend `packages/rfmedia-cli/README.md` with a concise command table and runnable examples for
   offline list/show, read-only diff, interactive apply, automation with `--yes`, dry-run, and
   JSON/YAML/CSV. Link to the feature guide rather than duplicating its complete schema.
3. Extend `rfmedia.example.yaml` with one bounded self-contained configured pack. Use template-safe,
   secret-free sample values and comments that unknown keys, built-in shadowing, inheritance,
   remote URLs, and external files are rejected.
4. Update the three generated completion templates and the parity test, then adjust both completion
   guides only where they list commands or maintenance rules. Completion must remain static and
   offline; it must not enumerate configured pack IDs by loading configuration.
5. Add an Unreleased entry to `packages/rfmedia-cli/CHANGELOG.md` and move issue #213 from
   `ROADMAP.md` to `docs/roadmap-archive.md` only after the PR is squash merged and the issue is
   confirmed closed.
6. Add or expand JSDoc on new public domain types, facade methods, pure diff/build functions, action
   results, origin lock/journal helpers, and command dependency interfaces. Document invariants and
   safety boundaries rather than narrating implementation mechanics.
7. Ensure generated-client documentation and source manifests need no change. If codegen remains
   untouched, state that the committed snapshot already supplied the required endpoints in the PR
   testing notes.

## Conventions/Release Surfaces

- Follow repository Markdown rules: headings surrounded by blank lines, wrapped prose, fenced
  commands with explicit languages, and no raw credentials or resolved secret values.
- Treat `packages/rfmedia-cli/README.md` as the concise command reference and
  `packages/rfmedia-cli/docs/features/lidarr-quality-presets.md` as the durable behavioral contract.
  Avoid copying the full feature spec or implementation plan into user documentation.
- Show exact commands and state whether they are offline, read-only, dry-run, or mutating. Every
  apply example must show the approval mode and must not imply that `--yes` bypasses validation,
  drift checks, or capability checks.
- Document all three built-ins with stable IDs/versions, assumptions, storage/bandwidth/compatibility
  tradeoffs, and exact quality/custom-format/naming policy derived from committed fixtures. Avoid
  vague marketing labels without their consequences.
- Keep output examples stable and sanitized: human review/progress on stderr; one versioned
  JSON/YAML document on stdout; fixed-column CSV row types; no terminal controls, formula-active CSV
  cells, headers, API keys, or raw server bodies.
- Changelog entries belong under `## [Unreleased]`, grouped by the existing Added/Changed style.
  Roadmap archiving happens only with authoritative merge evidence and includes the final PR link.
- Pull-request testing notes should list exact documentation, completion parity, architecture,
  codegen-drift, focused test, typecheck, and build commands with pass/fail results.

## Must-Read List

1. **Required:** `docs/plans/lidarr-quality-presets/feature-spec.md` — frozen v1 scope and behavior.
2. **Required:** `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` — generated/private
   boundary and codegen rules.
3. **Required:** `packages/rfmedia-cli/src/lib/lidarr/client.ts`,
   `packages/rfmedia-cli/src/lib/lidarr/types.ts`, and
   `packages/rfmedia-cli/src/lib/lidarr/transport.ts` — actual facade, projector, and transport
   contracts.
4. **Required:** `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` and
   `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` — review/recovery vocabulary and hardened
   storage precedents, with the preset-workflow separation noted above.
5. **Required:** `packages/rfmedia-cli/README.md`, `rfmedia.example.yaml`,
   `packages/rfmedia-cli/CHANGELOG.md`, `ROADMAP.md`, and `docs/roadmap-archive.md` — all public and
   release surfaces that must change.
6. **Required:** `docs/features/shell-completion.md` and
   `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` — three-shell parity and
   offline completion contract.
7. **Nice to have:** `packages/rfmedia-cli/docs/features/lidarr-search-lookup.md`,
   `packages/rfmedia-cli/docs/features/lidarr-albums.md`, and
   `docs/features/plan-apply-workflow.md` — current style and cross-feature terminology.
