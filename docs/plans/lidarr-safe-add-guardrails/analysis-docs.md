# Documentation Analysis: lidarr-safe-add-guardrails

## Executive Summary

The current operator and maintainer documentation already describes artist add as a sealed
`lidarr discover --add` plan followed by a separate `lidarr apply`, but it presents
`monitored: false`, `monitorNewItems: "none"`, and `searchForMissingAlbums: false` as fixed policy
and repeatedly says configurable defaults and post-add normalization remain open under issue #206.
The implementation documentation must replace those stale statements with an exact contract:
unmonitored remains the default, monitoring requires an explicit positive opt-in, missing-album
search remains disabled, metadata-profile omission is allowed only when a unique structurally
albums-only profile can be proved, and album-type normalization is a sealed, resumable post-add
stage that never causes the artist-create request to be resent.

The canonical update surface is the Lidarr discovery, mutation plan/apply, generated-client, and
execution-lane guides, plus the package README, changelog, live roadmap, and shipped-work archive.
Shell completion parity is part of the public CLI contract, but the generic completion guide needs
an update only if its documented behavior or command inventory changes.

## Must-Read Documents

### Required

- `docs/plans/lidarr-safe-add-guardrails/analysis-architecture.md`: Current artist-add ownership,
  plan compatibility, profile projection, post-add staging, and non-idempotent resume constraints.
- `docs/plans/lidarr-safe-add-guardrails/analysis-patterns.md`: Existing fixed-policy enforcement,
  exact-key plan parsing, album-type selector reuse, completion parity, and test conventions.
- `docs/plans/lidarr-safe-add-guardrails/analysis-integration.md`: Lidarr wire names, facade
  boundaries, profile data, album reads/writes, and the create-then-normalize integration sequence.
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`: Canonical operator guide for
  `discover --add`; currently requires every resource explicitly, documents fixed add policy, and
  lists #206 as intentionally unshipped.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Canonical artifact, review, apply,
  possible-dispatch, reconciliation, history, resume, and album-type monitoring contract.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`: Generated/manual ownership and
  discovery artist-add contract; currently documents a fixed POST body and the narrow required
  operations.
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`: Retry ownership, discovery
  handoff, non-idempotent add dispatch, resume ordering, and the current “#206 remains open”
  statement.
- `packages/rfmedia-cli/README.md`: Primary public command reference and copy-paste discovery,
  artist-add review/apply, album-type monitoring, and recovery examples.
- `packages/rfmedia-cli/CHANGELOG.md`: `[Unreleased]` currently describes the fixed add policy and
  explicitly excludes #206.
- `ROADMAP.md`: Living issue inventory; #206 is the remaining Phase C safe-add item and must remain
  open until implementation is merged.
- `docs/roadmap-archive.md`: Shipped discovery history currently says post-add defaults remain open;
  update only with authoritative issue/PR completion evidence.

### Nice-to-have

- `docs/plans/lidarr-discovery-safety/design.md`: Historical rationale for the preview-first,
  explicit-rank, plan-only handoff; useful when preserving the original safety boundary.
- `packages/rfmedia-cli/docs/features/lidarr-albums.md`: Existing closed album-type vocabulary and
  artist-scoped album-read behavior; useful terminology, but not the canonical mutation guide.
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`: Installation and static-completion
  behavior. Read when changing completion semantics, but do not turn it into a full duplicated
  command reference merely because flags are added.
- `.github/pull_request_template.md`: Required release handoff structure, including exact
  verification commands and pass/fail results under `## Testing`.
- [Issue #206](https://github.com/yandy-r/rfmedia-apps/issues/206): Original scope and rationale;
  its suggested files and `searchForNewArtist` wording are older than the current plan/apply and
  generated-client architecture.

## Architecture Docs

- **`packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` is the primary lifecycle document.**
  Extend its artist-add sections to describe resolved policy in the sealed plan, structural
  metadata-profile defaulting, the create/normalize stage boundary, partial or uncertain
  postconditions, and pinned resume without a second artist POST.
- **`packages/rfmedia-cli/docs/features/lidarr-generated-client.md` owns the API boundary.** Update
  the discovery artist-add contract with the exact Lidarr field
  `addOptions.searchForMissingAlbums`, detailed metadata-profile projection needed to prove
  albums-only semantics, and the facade-owned album read/unmonitor operations used after add.
  Preserve private generated modules, the single handwritten transport owner, and offline codegen.
- **`packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md` owns scheduling and retry
  semantics.** Replace the #206 deferral with the shipped staged lifecycle and state which reads
  are retryable, which writes are not automatically retried, and how resume continues
  normalization without redispatching creation.
- **`packages/rfmedia-cli/docs/features/lidarr-discovery.md` owns operator intent.** It should
  explain that explicit rank approval still creates reviewed intent only; defaults and opt-ins are
  resolved before the plan is sealed and cannot be changed at apply.
- The root `docs/architecture/` documents deployment and service architecture rather than
  `rfmedia-cli` Lidarr internals. No update there is required for this feature.

## Reading List

1. Read the three current `analysis-*.md` files first; treat the current sealed artist-add lane,
   generated-client boundary, and resumable post-add model as authoritative over issue #206's stale
   affected-file suggestions.
2. Read `lidarr-discovery.md` and the artist-add portions of `lidarr-plan-apply.md` together to
   preserve the preview -> sealed plan -> separately approved apply boundary.
3. Read the album-monitoring portions of `lidarr-plan-apply.md` and `lidarr-albums.md` before
   documenting selector vocabulary, exact artist scoping, changes-only updates, and empty/eventual
   album metadata.
4. Read `lidarr-generated-client.md` and `lidarr-execution-lanes.md` before documenting profile
   inspection, wire fields, retry ownership, possible-dispatch evidence, or resume behavior.
5. Audit the package README, changelog, ROADMAP, and roadmap archive for every statement that calls
   the policy fixed or #206 unshipped.
6. Audit Bash, Zsh, and Fish completion templates plus `templates.spec.ts` as executable
   documentation of the final command and option surface.
7. Read the pull request template before handoff and record exact test, typecheck, build,
   architecture, codegen, completion-parity, markdownlint, and documentation validation outcomes.

## Documents That Must Be Updated

- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`
  - Show the final add-option syntax without inventing a direct mutation path.
  - State that omission remains unmonitored and only an explicit positive choice enables artist
    monitoring.
  - Keep `monitorNewItems: "none"` and `searchForMissingAlbums: false` distinct from artist
    monitoring; do not imply that monitored opt-in enables new-album monitoring or search.
  - Explain metadata-profile omission, unique structural albums-only resolution, ambiguity/failure
    behavior, and explicit-reference override.
  - Document sealed post-add album-type selectors and the fact that discovery still writes only a
    plan.
  - Remove #206 from intentionally unshipped scope after merge.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
  - Replace “fixed policy” language with resolved safe defaults plus explicit opt-in.
  - Document every reviewed policy/postcondition field, risk presentation, compatibility for old
    v2 artist-add artifacts, and that apply never recomputes defaults.
  - Describe create verification, artist-scoped album readiness/read-back, changes-only unmonitor,
    terminal success, partial/uncertain outcomes, and resume from “artist verified, normalization
    pending” without another POST.
  - Clarify that empty album metadata is not automatically proof that requested normalization is
    complete unless the final implementation defines that explicit postcondition.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
  - Update the facade method/endpoint table and artist-add body contract.
  - Document the narrow generated-independent metadata-profile album-type projection.
  - Use `searchForMissingAlbums`; identify `searchForNewArtist` as non-wire terminology if it
    remains visible at all.
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
  - Document retry ownership for profile/album reads, non-retry artist creation, idempotent
    album-unmonitor writes, bounded verification, and staged resume ordering.
  - Remove the statement that configurable safe add defaults remain under #206 after shipment.
- `packages/rfmedia-cli/README.md`
  - Update the existing discovery handoff and mutation plan/apply examples rather than adding a
    parallel command story.
  - Include default unmonitored behavior, explicit monitored opt-in, search-disabled guarantee,
    metadata-profile default/failure rules, post-add selector example, and pinned resume guidance.
- `packages/rfmedia-cli/CHANGELOG.md`
  - Add a concise `[Unreleased]` entry for safe add defaults and resumable post-add guardrails.
  - Remove #206 from the existing “outside this release” sentence once delivered.
- `ROADMAP.md`
  - After merge, remove #206 from the open Phase C table and reconcile Layer 2 wording/counts.
  - Do not mark #219 or optional #204 complete.
- `docs/roadmap-archive.md`
  - After merge, add #206 and its real closing PR to the shipped Layer 2 record and update the
    operator note that currently calls post-add defaults open.

## Shell Completion and Index Parity

- Any new or changed command flags require synchronized edits to
  `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`.
- Extend `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` to prove the same option
  names, ordering/value semantics where applicable, and static network-free behavior in all three
  shells.
- Update `packages/rfmedia-cli/docs/features/shell-completion.doc.md` only if generic completion
  behavior or its curated Lidarr inventory changes; installation instructions do not need a
  feature-specific rewrite.
- `docs/README.md` already indexes discovery, plan/apply, execution-lane, and generated-client
  guides. No index change is required unless a new standalone safe-add guide is created.
- Root `README.md` already links the package README and does not contain the Lidarr command
  contract. The required README update is `packages/rfmedia-cli/README.md`; avoid duplicating the
  detailed workflow at repository root.

## Documentation Gaps

- No current document separates artist monitoring opt-in from new-item monitoring, initial album
  monitoring, missing-album search, and post-add album normalization. Document these as independent
  policies so a single boolean cannot be read as enabling all side effects.
- No current guide defines how an albums-only metadata profile is proven, how root-folder defaults
  participate, or how missing, malformed, or multiple candidates fail closed.
- The docs do not yet describe a composite artist-add result where creation is verified but
  album-type normalization is pending, failed, or uncertain.
- Existing resume guidance assumes exact-MBID artist reconciliation is the final artist-add
  postcondition. It must explain how durable stage evidence resumes normalization without resending
  the non-idempotent create.
- Current wording treats `searchForMissingAlbums: false` as part of one fixed policy. The new docs
  must keep search disabled even when artist monitoring is explicitly enabled and must not use the
  stale `searchForNewArtist` wire name.
- Eventual Lidarr album population is undocumented for post-add workflows. State the bounded
  readiness/verification rule and what the operator should do when requested album-type guarantees
  cannot yet be proved.
- The current changelog, discovery guide, plan/apply guide, execution-lane guide, package README,
  and roadmap archive all contain explicit #206 deferral language; leaving any one unchanged would
  create contradictory release documentation.
- Completion parity is easy to miss because the templates are source files rather than Markdown.
  Treat Bash, Zsh, Fish, and their parity test as required public-contract updates.
