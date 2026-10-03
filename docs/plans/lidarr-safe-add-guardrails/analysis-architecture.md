# Architecture Analysis: lidarr-safe-add-guardrails

## Executive Summary

Issue #206's affected-file hints are stale: the current repository already has a sealed,
non-idempotent artist-add lane reached through `lidarr discover --add`, with exact-MBID planning,
resource preflight, durable possible-dispatch evidence, and reconciliation. It already hard-codes
unmonitored, no-new-item-monitoring, and no-search behavior; the remaining architectural work is to
turn selected values into safe defaults with controlled overrides, resolve an actually
albums-only metadata profile, and make optional album-type normalization a staged, resumable
post-add operation without bypassing plan/apply safety.

## Architecture Context

- **System Structure**: The only public artist-create path is currently
  `commands/lidarr-discover.ts` -> `actions/lidarr/discover.ts` ->
  `actions/lidarr/plan-artist-add.ts` -> a sealed v2 `artist-add` artifact -> generic
  `lidarr apply` routing -> `apply-artist-add.ts` and
  `apply-artist-add-entry-execution.ts` -> the handwritten `LidarrClient` facade. The issue's
  suggested `actions/lidarr/add.ts` and `lib/lidarr/add-options.ts` do not exist, and adding a
  second direct mutation path would duplicate the stronger plan/apply lane.
- **Data Flow**: Planning validates approved Last.fm recommendations, resolves exact root/profile
  references, verifies authoritative Lidarr lookup identity and MBID absence, then seals all write
  intent into the checksummed plan. Apply revalidates referenced resources and exact-MBID state,
  persists a `possibly-dispatched` history record before POST, calls `prepareArtistAdd` and
  `addArtist`, and reconciles the ambiguous result by exact MBID before recording a terminal
  outcome.
- **Current Safety Baseline**: `LidarrArtistAddInput`, `LidarrArtistAddOperationV2`, plan entries,
  plan validators, idempotency material, facade validation, and the POST body all require
  `monitored: false`, `monitorNewItems: "none"`, and `searchForMissingAlbums: false`. This is
  stronger than a default: monitored/search overrides are currently unrepresentable and rejected.
- **Wire-Contract Correction**: The live committed Lidarr OpenAPI names the artist option
  `addOptions.searchForMissingAlbums`; `searchForNewArtist` appears only in the older research
  source behind issue #206. Implementation should preserve the generated API name and translate
  user-facing policy at the handwritten facade rather than inventing a non-schema wire property.
- **Metadata-Profile Flow**: Artist-add planning currently requires an explicit metadata-profile
  reference and the stable facade projects profiles only as `{id, name}`. The generated
  `MetadataProfileResource` has allowed primary/secondary album-type details, and root folders
  expose default profile IDs, but both details are deliberately stripped from the public
  projections. A trustworthy albums-only default therefore requires a new narrow,
  generated-independent projection/resolver; matching only the name `Standard` is not semantic
  proof.
- **Post-Add Flow**: Existing album monitoring already provides a closed album-type vocabulary,
  fail-closed artist-scoped scans, and the facade operation
  `setAlbumsMonitored(albumIds, false)`. Reuse those pure selectors and client boundary, but do not
  call the existing plan action as an unreviewed nested mutation: it assumes the artist/albums
  already exist and produces a separate artifact.
- **Integration Points**: Resolve defaults before sealing the add plan; persist every explicit
  override and normalized post-add selector in the operation/entry/checksum/idempotency contract;
  then execute post-add normalization only after exact-MBID creation is verified. Resume must
  recognize “artist exists, guardrail pending” and continue the idempotent album update without
  resending the non-idempotent artist POST.
- **Import Boundary**: `lidarr validate-import` is currently a read-only manual-import probe and
  explicitly never submits an import. Do not silently attach artist-create behavior to that lane;
  any actual import mutation needs a separately specified, sealed contract.

## Critical Files Reference

- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`: Current public add grammar and required
  root/profile/plan handoff; the natural place to expose defaults or overrides if discover remains
  the only entrypoint.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Lidarr command hierarchy and generic plan/apply
  registration; relevant if issue #206 introduces a first-class `lidarr add` leaf.
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`: Connects approved recommendations to the
  artist-add planner and renders plan/apply handoff outcomes.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`: Resolves live roots/profiles and
  exact identities, rejects ambiguous resources, and builds the existing sealed add artifact.
- `packages/rfmedia-cli/src/types/lidarr.ts`: Stable generated-independent artist, root, profile,
  and `LidarrArtistAddInput` contracts; currently encodes fixed false/none literals.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Public immutable artist-add operation, entry,
  history, failure, and result schemas that must carry any override and post-add stage.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Strict response projectors; currently discards
  root-folder defaults and metadata-profile album-type composition.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole handwritten generated-client owner;
  validates and sends artist POSTs and already owns scoped album reads and bulk monitoring writes.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: Canonical artist-add policy,
  risk text, referenced-resource preflight inputs, and idempotency-key material.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Exact-key parsing, canonicalization,
  checksum validation, v2 artist-add construction, history, and resume selection.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`: Whole-plan preflight, admission,
  resume, summary, and stop-on-uncertainty orchestration.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`: Non-idempotent
  dispatch boundary and exact-MBID reconciliation; post-add staging belongs here or in a tightly
  owned helper invoked from here.
- `packages/rfmedia-cli/src/lib/lidarr/album-types.ts`: Closed, canonical album-type selectors and
  matching semantics suitable for post-add normalization.
- `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts`: Existing fail-closed selection/accounting
  pattern for artist-scoped album-type monitoring plans.
- `packages/rfmedia-cli/src/actions/lidarr/album-scan.ts`: Bounded artist/album scan behavior;
  useful precedent, but post-add should scope only to the newly verified artist ID.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts`: All three completion
  templates must remain in parity if the command or flags change.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Architecture gate enforcing private
  generated Lidarr imports, sole Fetch ownership, and the current artist-add mutation owner.

## Cross-Cutting Concerns

- **Plan Compatibility**: Exact-key validators and checksum recomputation mean policy fields cannot
  be added only at the command or client layer. Old fixed-policy plans must remain readable while
  new artifacts seal normalized defaults/overrides; introduce an explicit compatible shape or
  version decision rather than weakening validation.
- **Non-Idempotent Recovery**: Artist POST is non-idempotent. Post-add failures must never turn into
  an automatic resend; durable history needs enough stage evidence to distinguish create pending,
  create verified/normalization pending, and fully satisfied.
- **Partial Success**: Creation and album normalization cannot be atomic across Lidarr endpoints.
  A verified create followed by failed normalization needs a structured partial/uncertain outcome
  and safe resume instruction, while later entries remain subject to the existing admission-stop
  policy.
- **Eventual Metadata**: Albums may not be populated immediately when artist creation returns.
  Empty album reads must not be treated as successful normalization without a defined readiness,
  retry, or explicit no-albums contract.
- **Profile Semantics**: “Albums only” should be established from allowed profile album types,
  ideally honoring a root-folder default only after verifying that profile's composition.
  Missing, malformed, or multiple candidate profiles should fail closed or require an explicit
  reference.
- **Override Risk**: Allowing `monitored: true` changes satisfaction checks, risk messaging, plan
  schema, POST `monitor`/`monitored`/`monitorNewItems` consistency, and likely downstream cascade
  warnings. Search should remain false unless a separately explicit opt-in is confirmed by scope.
- **Boundary Ownership**: Upper layers must not import generated Lidarr types/operations or write
  `/api/v1/` paths. New wire projection and POST behavior stays in `lib/lidarr/client.ts` and
  `lib/lidarr/types.ts`; architecture and codegen contract tests protect this boundary.
- **Bounded Work**: Keep `max-add`, scheduler lanes, cancellation, resource caps, exact artist
  scoping, and closed album-type selectors. Post-add work must not degrade into a whole-library
  album scan.
- **Output Contracts**: Human review, JSON/CSV envelopes, plan risk summaries, history records,
  test mocks, and Bash/Zsh/Fish completion parity all change when new options or result stages are
  exposed.

## Parallelization Opportunities

- **Policy/Profile Workstream**: A pure safe-default resolver plus narrow metadata-profile/root
  projections and facade tests can be developed independently of CLI presentation after the
  desired public option names are fixed.
- **Post-Add Workstream**: A scoped, idempotent album-type normalization helper and tests can be
  developed against existing `listAlbums`, `matchesAlbumTypeSelectors`, and
  `setAlbumsMonitored`, but integration into history/resume must wait for the plan-stage schema.
- **CLI Workstream**: Commander grammar, error messages, machine-output expectations, and three
  shell completion templates can proceed once the plan action option shape is agreed.
- **Contract Workstream**: Plan-engine canonicalization/validation, risk/idempotency material, and
  backward-compatibility fixtures form one tightly coupled task; split unit tests from production
  edits, not the schema across independent owners.
- **Final Integration**: Apply classification, durable stage history, reconciliation, and
  end-to-end resume tests should be one sequential integration task because they jointly protect
  against duplicate artist creation.

## Implementation Constraints

- Preserve the existing discover -> sealed plan -> reviewed apply workflow; if a new `lidarr add`
  command is added, it should feed the same planner rather than call `LidarrClient.addArtist`
  directly.
- Treat false/unmonitored values as defaults at input resolution, then store the resolved policy
  explicitly in every plan entry. Apply must never recompute defaults from current config.
- Do not use the stale `searchForNewArtist` wire name. The committed generated contract supports
  `searchForMissingAlbums`; any user-facing alias must map to that field inside the facade.
- Do not infer albums-only semantics from a profile name alone. Use a stable detailed projection
  of allowed primary and secondary types and fail closed when the server omits required evidence.
- Seal post-add album-type selectors into the reviewed artifact. Resolve concrete album IDs only
  after the artist has a verified Lidarr ID, and restrict reads/writes to that artist.
- Reuse closed selector parsing and facade album-monitoring writes, but keep post-add lifecycle
  ownership with artist-add apply so history and resume cannot dispatch the create twice.
- Keep generated modules private, preserve the single authenticated transport owner, update the
  resilience decorator and test client mocks for any new facade method, and run architecture plus
  offline Lidarr codegen contract gates.
- Verify behavior at four layers: pure option/profile/selector policy, sealed plan
  canonicalization and backward compatibility, exact POST body and facade projections, and
  create-success/normalization-failure/resume integration.
