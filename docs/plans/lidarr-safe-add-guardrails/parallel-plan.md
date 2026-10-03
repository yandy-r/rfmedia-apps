# Lidarr Safe Artist-Add Guardrails Implementation Plan

Extend the existing discovery-to-plan-to-apply artist-add lane with safe omitted defaults, a structural albums-only metadata-profile fallback, and optional post-add album-type normalization. New intent remains sealed in exact v2-compatible plan shapes, while legacy artist-add artifacts retain their original checksum semantics. The apply lane will persist distinct creation and normalization stages so every crash boundary resumes without a duplicate artist POST, and public CLI/completion/documentation contracts will move together.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-lidarr-safe-add-guardrails/ (branch: feat/lidarr-safe-add-guardrails)

## Critically Relevant Files and Documentation

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`: Existing resource resolver and sealed plan producer.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`: Sole artist-create dispatch owner and recovery boundary.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Exact-key parsing, checksums, history, and resume eligibility.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Stable facade and authenticated transport owner.
- `packages/rfmedia-cli/src/lib/lidarr/album-types.ts`: Canonical selector parsing and matching semantics.
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`: Public guardrail options.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Cross-shell parity contract.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Required plan/apply safety documentation.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`: Required generated boundary documentation.
- `docs/plans/lidarr-safe-add-guardrails/shared.md`: Consolidated architecture and repository patterns.

## Implementation Plan

### Phase 1: Stable Contracts and Server Evidence

#### Task 1.1: Extend Stable Artist-Add and Plan Contracts Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`

Represent resolved `monitored` as a boolean while retaining `false` as the producer default. Keep `monitorNewItems: "none"` and `searchForMissingAlbums: false` fixed. Add stable metadata-profile album-type evidence, canonical post-add unmonitor selectors, and the minimum durable normalization-stage/result types needed to distinguish create pending, create verified with normalization pending, normalization verification pending, and terminal completion. Keep the legacy exact artist-add contracts representable so old plans can be parsed without checksum drift.

#### Task 1.2: Project Root and Metadata-Profile Safety Evidence Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.test.ts`

Strictly project root-folder default metadata-profile IDs and allowed primary/secondary metadata-profile album types into stable frozen values. Reject malformed nested evidence as a whole response, preserve bounds and fresh copies, and do not expose generated DTOs. Focus tests on a valid albums-only profile, mixed profiles, missing or malformed nested values, root defaults, and immutability.

#### Task 1.3: Seal Required Generated Operations Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

Require the already committed lookup/create, artist-scoped album list, album-monitoring update, root-folder, and metadata-profile operations/endpoints used by this feature. Preserve offline deterministic code generation and the last-known-good generated tree. Do not refresh the OpenAPI snapshot or edit generated output.

### Phase 2: Facade and Sealed Planning Policy

#### Task 2.1: Implement Facade Defaults and Detailed Projections Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`

Return detailed root/profile projections through the handwritten facade and serialize only the live wire field `addOptions.searchForMissingAlbums`. Map the resolved artist monitoring choice explicitly while initial album monitoring, new-item monitoring, and missing-album search stay disabled. Verify exact default and explicit-monitored POST bodies, projection failure behavior, desired-state validation, and zero transport for invalid input.

#### Task 2.2: Extend Exact Plan Shapes and Durable Stage Parsing Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`

Canonicalize artist monitoring and sorted, deduplicated post-add selectors into extended operation/entry shapes, postconditions, checksum material, idempotency keys, risks, and history. Recognize legacy and extended shapes through separate exact-key sets; reject hybrids and unknown keys while preserving legacy checksum round trips. Resume must select intermediate normalization stages but skip only terminal verified success.

#### Task 2.3: Resolve Safe Defaults and Build the Reviewed Plan Depends on [2.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/album-types.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`

Resolve omitted artist monitoring to `false`. When metadata profile is omitted, prefer the selected root folder's default only if structural evidence proves it allows primary `Album` and no allowed secondary type; otherwise use a unique structural albums-only candidate and fail closed on zero or ambiguity. Canonicalize the existing closed post-add selectors into the plan. Preserve provenance-before-I/O, exact-MBID absence checks, caps, ordering, no partial writes, and existing-artist no-op behavior.

### Phase 3: Public CLI and Completion Parity

#### Task 3.1: Expose Guardrails Through Discover Add Depends on [2.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

Make metadata-profile optional through the deterministic structural fallback. Add a positive-only `--monitored` override and optional comma-separated `--unmonitor-types` input, validate selector grammar before config/client resolution, and forward normalized policy to the existing plan producer. Preserve human/machine stream separation and generic `lidarr apply`; do not introduce a direct mutation command or search override.

#### Task 3.2: Update Bash, Zsh, and Fish Completion Sources Together Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

Expose identical discover-add options and canonical album-type values in all three templates while preserving command scoping, file completion, and current argument behavior.

#### Task 3.3: Prove Completion Parity and Side-Effect Freedom Depends on [3.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Update exact option/value expectations for Bash, Zsh, and Fish together. Retain proof that completion generation does not load configuration, instantiate the client, or access the network.

### Phase 4: Crash-Safe Post-Add Normalization

#### Task 4.1: Execute and Verify the Composite Entry Safely Depends on [2.1, 2.2, 2.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.test.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.test.ts`

Keep this file as the sole production `addArtist()` owner. Reconcile exact MBID first, dispatch behind the durable possible-dispatch marker at most once, and persist creation-verified/normalization-pending once the authoritative artist ID is known. Read only that artist's albums, update only currently monitored matches in bounded calls, and re-read to verify. Before each album mutation persist a resumable verification-pending stage; on resume re-read and either verify or update only remaining IDs. Bounded empty album results must return an explicit resumable incomplete state rather than terminal success. Test crashes and failures around every marker, POST, reconciliation, album PUT, and terminal append, proving no resume sends a second artist POST.

#### Task 4.2: Integrate Admission, Resume, and Result Presentation Depends on [4.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`

Carry intermediate normalization outcomes through plan-wide history, resume selection, stop-on-uncertainty admission, dry-run, summaries, and safe next-action text. Creation verified with normalization pending is partial, not terminal success. Later non-idempotent admissions stop while the current entry is incomplete, and `--resume` continues normalization for the known artist without recreating it. Preserve structured human/JSON output without raw bodies or secrets.

### Phase 5: Architecture Gates and User Documentation

#### Task 5.1: Preserve Generated and Mutation Ownership Gates Depends on [4.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`

Keep generated imports private, authenticated Fetch single-owned, and artist creation restricted to the established entry executor. Allow only the minimum existing facade album-monitoring ownership required for normalization. Negative fixtures must reject command/planner artist adds, generated imports, handwritten Lidarr paths, and extra transport owners.

#### Task 5.2: Document Discovery and Plan-Apply Contracts Depends on [3.3, 4.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`

Document safe omission, explicit monitored override, root-aware structural albums-only fallback, canonical post-add selectors, partial completion, and crash/resume semantics. State that missing-album search and new-item monitoring remain disabled and normalization never authorizes a second artist POST.

#### Task 5.3: Document Facade and Execution-Lane Boundaries Depends on [2.1, 3.3, 4.2, 5.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
- `packages/rfmedia-cli/README.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
- `packages/rfmedia-cli/README.md`

Describe the stable structural profile projection, live `searchForMissingAlbums` mapping, bounded artist-scoped normalization, durable stages, and public CLI examples. Keep generated internals private and distinguish the synchronous plan/apply lane from deferred mutation queues.

#### Task 5.4: Record Release and ROADMAP Completion Depends on [5.2, 5.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/CHANGELOG.md`
- `ROADMAP.md`
- `docs/roadmap-archive.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/CHANGELOG.md`
- `ROADMAP.md`
- `docs/roadmap-archive.md`

Add a concise unreleased contract note. After focused tests, completion parity, architecture/codegen checks, typecheck, build, the full rfmedia suite, `npm run lint:md`, and `npm run format:check` are green, re-audit live GitHub issue totals and update ROADMAP counts/status plus the archive entry for issue #206. Use the actual PR number once created and avoid claiming merge or issue closure before authoritative GitHub verification.

## Advice

- Keep `searchForMissingAlbums: false`, `monitorNewItems: "none"`, and initial album monitoring `"none"` fixed; `--monitored` changes only the artist monitored flag.
- Treat profile names as display data, never as albums-only evidence; validate allowed primary and secondary types.
- Preserve legacy checksum behavior with explicit legacy and extended exact shapes instead of optional permissive keys.
- Do not nest the existing album-monitoring plan action inside artist-add apply; reuse selectors and facade operations while keeping one recovery history.
- Persist stage evidence before every non-idempotent or ambiguous boundary, and consider terminal success proven only after a fresh scoped re-read.
- Empty post-create album data is eventual-state uncertainty when normalization was requested, not proof that no work exists.
- Run Bash, Zsh, and Fish completion checks as one contract and keep generation side-effect free.
- Re-audit live issue counts immediately before ROADMAP closeout because repository totals can change during implementation.
