# Lidarr Quality Presets — Recommendations

## Executive Summary

Implement issue #213 as a dedicated desired-state workflow:

```text
rfmedia lidarr presets list
rfmedia lidarr presets show <pack-ref>
rfmedia lidarr presets diff <pack-ref>
rfmedia lidarr presets apply <pack-ref> [--dry-run] [--yes]
```

Version 1 must manage all three promised resource classes: quality-profile definitions, custom
formats and their profile scores, and the singleton naming configuration. It must include three
versioned built-in packs (`balanced`, `lossless`, and `space-saver`) and strict, fully
self-contained configured packs. Shipping only quality profiles, omitting configured packs, or
deferring naming/custom-format apply would not satisfy the issue.

The workflow should be additive and non-destructive. It owns same-name resources declared by the
selected pack, preserves unrelated resources and undeclared custom-format scores, and never
deletes, renames, reassigns artists, searches, downloads, or renames existing files. Diff and dry
run use fresh reads and perform no writes. Apply repeats the full preflight, obtains explicit
approval, serializes configuration applies per canonical Lidarr origin, checks for drift before
each write, applies in dependency order, and verifies each write from fresh live state.

Do not extend `rfmedia.lidarr-plan.v2`. Its numeric artist/album targets, exhaustive operation
unions, history assumptions, and artifact contracts do not fit name-resolved global configuration.
A dedicated workflow preserves existing artifacts while reusing their safety principles.

## Implementation Recommendations

### Product and command contract

- Add `list`, `show`, `diff`, and `apply` under `rfmedia lidarr presets`.
- Require one `<pack-ref>` for `show`, `diff`, and `apply`. Support
  `builtin:<id>` and `config:<id>`; allow an unqualified ID only when it resolves uniquely.
- Keep `list` and `show` offline and credential-free. They render the fully resolved local policy,
  provenance, version, digest, compatibility assumptions, tradeoffs, and explicit non-effects.
- Make `diff` a fresh live comparison that exits successfully whether changes exist or not.
  Machine output carries `hasChanges`; do not overload operational failure exit codes.
- Make `apply --dry-run` execute the same reads, schema validation, reference resolution, impact
  analysis, and diff as real apply, but issue zero mutation requests and write no apply journal.
- Require a default-no interactive confirmation after the complete review. Machine and non-TTY
  apply require `--yes`; `--yes` bypasses only the prompt.
- Keep human review and progress on stderr. JSON and YAML emit exactly one versioned document on
  stdout. CSV uses a fixed row union for summaries, resources, fields, warnings, assumptions, and
  naming examples.
- Update Bash, Zsh, and Fish completions and their parity tests in the same change. Completion may
  enumerate built-in and local configured pack IDs but must never connect to Lidarr.

### Preset policy

Ship three immutable built-in pack payloads, each with stable ID, integer version `1`, normalized
content digest, supported capability assumptions, and documented storage/bandwidth consequences:

| Pack          | Policy                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `balanced`    | Allow common lossless and high-quality lossy qualities, enable upgrades through the selected lossless cutoff, score curated source preferences moderately, and use readable artist/album/disc/track naming. |
| `lossless`    | Allow only supported lossless qualities, upgrade through the best declared lossless cutoff, strongly score curated lossless-source preferences, and retain quality/edition context in names.                |
| `space-saver` | Allow only a bounded high-quality lossy tier, stop upgrades at its declared cutoff, reject or penalize oversized/undesired sources through curated formats, and use compact but reversible names.           |

The exact quality names, group order, cutoff names, custom-format implementations and fields,
scores, and naming tokens must be frozen against a supported Lidarr integration fixture before the
registry is accepted. Placeholder policies or built-ins without real custom-format and naming
content are not acceptable v1 substitutes.

Use these ownership rules:

- Every pack contains at least one complete quality profile and one complete naming policy
  containing every persisted naming field. Each built-in also contains at least one real custom
  format; a configured pack may contain zero or more complete custom formats.
- Quality item/group ordering, allowed state, upgrade policy, cutoff, and score thresholds are
  complete policy for a managed profile.
- Declared custom-format scores are managed by name. Existing scores for undeclared custom formats
  are preserved when updating a profile because Lidarr requires every current custom format in
  `formatItems`. A newly created profile receives schema-default score `0` for undeclared formats.
- A declared custom format is a complete ordered definition. Same normalized name means adopt and
  update after its live shape is fully validated; ambiguity blocks the whole preflight.
- Omitted profiles and custom formats are retained. V1 has no delete, prune, rename, or force-stale
  option.
- The naming singleton is fully owned by the selected pack. Partial naming overlays and pack
  inheritance are deferred because they make the resolved policy harder to review and reproduce.
- Configured packs are fully self-contained, use the same versioned exact-key schema and live
  validation as built-ins, and may not shadow a built-in ID.
- No pack is auto-selected merely because it exists. If a configured default is supported, it
  supplies a CLI convenience only; apply remains explicit.
- Built-ins are local package data. Never fetch remote/community packs during list, diff, or apply.

### Resolution, diff, and apply

- Use portable normalized names in preset documents and resolve server-local IDs from fresh schema
  and resource reads for every run. Matching is trim plus case normalization only; never fuzzy
  match or infer renames.
- Reject unknown keys, duplicate normalized names, unsupported implementations, invalid dynamic
  field types, unsafe regexes, unresolved qualities/cutoffs, duplicate or dangling scores,
  malformed live resources, and invalid naming templates before the first write.
- Report `create`, `update`, `unchanged`, and `retained`, with deterministic field-level
  before/after values. Preserve behavioral order for quality trees and custom-format
  specifications.
- Report artist-assignment counts for managed quality profiles and referencing profile names for
  changed custom formats. Clearly separate preset assumptions, live observations, and expected
  consequences.
- Use a fresh `local-only` Lidarr client with stale serving disabled. Read-only discovery may use
  the existing bounded retry path; mutations must not be hot-retried.
- Acquire an exclusive local apply lock keyed by canonical Lidarr origin before final preflight and
  hold it until all per-resource outcomes are durable. A plan-ID claim is insufficient because two
  different applies can target the same global resources.
- Apply sequentially: custom formats, refresh custom-format IDs and profile schema, quality
  profiles, then naming. Stop all later admissions after a failed, stale, uncertain, or
  non-durable write; do not continue the independent naming stage in v1.
- Immediately before each write, re-read the affected resource and preserved fields and compare
  them with the reviewed before-state. Any third state blocks that resource and the remaining
  pipeline; v1 has no drift override.
- Read back after every mutation and compare the semantic managed projection. A timeout or
  disconnect after dispatch is `uncertain`, not safely retryable.
- Persist a bounded per-resource apply journal with `succeeded`, `satisfied`, `failed`,
  `uncertain`, and `not-attempted` outcomes. Reruns reconcile live state first and converge
  forward; never attempt automatic rollback.
- A second apply against converged state performs zero mutations, does not prompt, and reports all
  managed resources as satisfied/unchanged.

### Boundaries and validation

- Keep generated SDK imports and wire translation in
  `packages/rfmedia-cli/src/lib/lidarr/client.ts`; keep authenticated Fetch in `transport.ts`.
- Add narrow rich-definition facade methods rather than widening the existing
  `listQualityProfiles(): LidarrProfile[]` contract used by artist assignment.
- Construct complete quality-profile PUT bodies from a fresh live schema. Include every current
  custom format exactly once and preserve undeclared scores as specified above.
- Confine the OpenAPI string-ID PUT quirk to the facade. Preset/domain types use positive integer
  IDs only after live resolution.
- Treat custom-format schema and naming examples as untrusted `unknown` responses and project them
  through bounded exact-key validators.
- Restrict configured custom-format conditions in v1 to the four verified implementations:
  `ReleaseTitleSpecification`, `ReleaseGroupSpecification`, `IndexerFlagSpecification`, and
  `SizeSpecification`. Intersect that local allowlist with the connected server schema.
- Enforce file bytes, parse depth, aliases, collection counts, quality-tree depth/nodes, condition
  counts, scalar lengths, score ranges, expanded result size, and terminal-safe text limits.
- For regex fields, use a documented safe subset and reject backreferences, lookbehind, controls,
  bidirectional controls, nested ambiguous quantifiers, and oversized expressions.
- Validate naming locally for required tokens and path safety, request server examples with the
  saved positive ID and every candidate persisted field, sanitize examples for display, and treat
  PUT plus fresh GET as authoritative. Examples enrich review but cannot prove persistence.
- Preserve existing origin validation, header-only API-key injection, redirect rejection, timeouts,
  bounded bodies, cancellation, error sanitization, and secret-free output.

## Technology Choices

| Choice         | Recommendation                                                                           | Rationale                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Workflow       | Dedicated live `presets` diff/apply                                                      | Fits name-resolved dependent resources without breaking `lidarr-plan.v2`.                                         |
| Preset storage | Frozen TypeScript data for built-ins; strict existing YAML config section for user packs | No remote execution or new parser/runtime dependency; built-ins receive normal code review.                       |
| API access     | Existing generated SDK behind handwritten facade                                         | The committed snapshot already contains all required operations and preserves the single transport/auth boundary. |
| Diff engine    | Pure handwritten semantic normalization and comparison                                   | Small resource counts do not justify a diff dependency; behavioral array order can be handled explicitly.         |
| Identity       | Portable names in packs, live integer IDs in one run                                     | Avoids instance-specific preset data and accidental cross-instance targeting.                                     |
| Concurrency    | Parallel bounded GET discovery; sequential writes                                        | Improves read latency while preserving deterministic output and dependency safety.                                |
| Locking        | Existing lock primitives extended to canonical-origin scope                              | Prevents two local configuration applies with different identities from interleaving.                             |
| Recovery       | Durable per-resource journal plus convergence on rerun                                   | Lidarr has no cross-resource transaction or idempotency key; rollback would create new risk.                      |
| Validation     | Exact-key local schema plus fresh live capability schema                                 | Local checks bound hostile input; live checks account for Lidarr-version differences.                             |
| Dependencies   | No new runtime package                                                                   | Existing generated client, validators, formatter, locking, and persistence facilities are sufficient.             |

Upgrade vulnerable production dependencies on the parser/runtime path, especially `js-yaml`, in
the release branch and re-run `npm audit --omit=dev`. Do not refresh the OpenAPI snapshot or
generator merely for this feature; do so only if contract fixtures demonstrate a real mismatch.

## Phasing

Phasing should organize implementation and review, not reduce the v1 acceptance scope.

### Phase 1 — Contracts and curated policy

- Freeze the three built-in `@1` payloads against a supported Lidarr fixture.
- Define exact pack/config/domain/result schemas, limits, stable error codes, output versions, and
  origin-lock/journal records.
- Decide and document the minimum supported Lidarr capability/version floor.

Exit criterion: all built-ins validate offline and configured packs reject unknown or unsafe
content with precise paths.

### Phase 2 — Read and diff

- Add strict rich domain projectors and narrow facade GET/schema/example methods.
- Implement pack resolution, capability validation, ID resolution, impact analysis, canonical
  comparison, and `list`/`show`/`diff` presentation.
- Add deterministic JSON/YAML/CSV contracts and no-op behavior.

Exit criterion: fixtures cover create/update/unchanged/retained for all three resource classes,
with zero mutation calls.

### Phase 3 — Safe convergence

- Add facade create/update methods with no mutation retry.
- Implement origin-scoped locking, final per-resource drift checks, ordered writes, read-back
  verification, durable outcomes, interruption handling, and convergence-based rerun.
- Add interactive approval, `--yes`, and authoritative `--dry-run` precedence.

Exit criterion: integration tests prove ordered writes, zero-write dry run, drift blocking,
uncertain outcomes, partial journaling, and second-run zero mutation.

### Phase 4 — Product integration

- Add help, example config, feature documentation, command tests, architecture gates, generated
  contract tests, and Bash/Zsh/Fish completion parity.
- Run the repository's complete static, unit, build, integration, architecture, markdown, diff,
  audit, and completion gates.

Exit criterion: issue acceptance is demonstrated end to end in human and machine formats without
regressing existing Lidarr plan/apply behavior.

## Quick Wins

- Reuse the current command lazy-loading, format resolution, confirmation, error taxonomy,
  execution metadata, scheduler, terminal-width handling, and machine-stream separation.
- Reuse exact name/ID resolution behavior from artist-profile selection.
- Reuse current local-only fresh/no-retry action setup from Lidarr planning.
- Reuse the mutation presenter's review vocabulary, 20-row default preview, verbose expansion, and
  safe-next-command conventions while creating a resource/field-specific presenter.
- Add required generated operation assertions before facade implementation; the snapshot already
  contains the endpoints.
- Build fixtures for one create, one update, one unchanged, and one retained resource per class
  before writing the apply orchestrator.
- Implement offline `list` and `show` as soon as the registry and config parser exist; these provide
  immediately testable onboarding value without a live server.

## Improvement Ideas

These are legitimate follow-ups, not substitutes for the v1 scope:

- A new sealed `rfmedia.lidarr-config-plan.v1` artifact for asynchronous team review and checksum
  pinning.
- Explicit `--expected-diff-checksum` support for non-interactive review/apply separation.
- Signed, digest-pinned remote preset catalogs with explicit trust roots; never silent updates.
- Configured pack inheritance with a documented collection merge model and field provenance.
- Partial naming ownership for organizations that compose naming policy independently.
- A separate high-risk prune command with reference analysis, explicit migration intent, and
  independently reviewed deletion entries.
- Cross-host distributed locking for multiple automation controllers targeting one Lidarr origin.
- An opt-in `--detailed-exit-code` shared consistently across repository diff commands.
- Redacted, non-applyable review exports for sharing operational policy.
- More custom-format implementations only after local typed validators and server fixtures exist.

## Risk Assessment

No critical security issue is inherent in the feature if it stays behind the existing facade and
transport. The following risks are release-relevant:

| Severity | Risk                                                                                             | Required control                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| High     | Shared custom-format/profile/naming changes have library-wide blast radius.                      | Impact counts, complete diff, explicit approval, additive ownership, no v1 deletion.                                   |
| High     | Different applies can race on the same global resources.                                         | Canonical-origin lock plus immediate per-resource drift checks; no force-stale mode.                                   |
| High     | Multi-resource apply is non-transactional and may stop partially converged.                      | Sequential dependencies, durable per-resource outcomes, read-back, uncertain classification, forward reconciliation.   |
| High     | Dynamic custom-format fields and regexes can become server-executed denial-of-service policy.    | Local implementation/field allowlist, safe regex subset, strict bounds, and fresh live-schema intersection.            |
| High     | YAML alias/merge complexity and vulnerable parser versions can amplify hostile configured packs. | Upgrade `js-yaml`, retain `CORE_SCHEMA`, exact-key validation, byte/depth/count/expansion limits.                      |
| High     | Complete quality-profile PUTs can erase required or unmanaged state.                             | Construct from fresh schema, include every format exactly once, preserve undeclared existing scores, verify read-back. |
| Medium   | Naming templates can redirect future filesystem layout or inject terminal controls.              | Full naming review, token/path checks, bounded sanitized examples, authoritative PUT/read-back.                        |
| Medium   | One API key grants broad read/write authority.                                                   | Single transport, header-only key, same-origin and redirect controls, secret-free errors/output, explicit approval.    |
| Medium   | A compromised bundled preset is a supply-chain policy change.                                    | Local reviewed data, stable version/digest, changelog, no auto-fetch or auto-apply.                                    |
| Medium   | Results expose origin, IDs, regexes, naming policy, and before/after state.                      | Owner-only journal storage, bounded data, documented sharing/retention, no raw bodies or headers.                      |
| Medium   | Bounded HTTP bytes can still contain semantically huge recursive state.                          | Projector node/depth/count limits; reject rather than truncate state used to authorize writes.                         |
| Low      | Large diffs, Unicode, color-only status, or spreadsheet formulas can hide or distort review.     | Textual actions, display-width-aware bounded output, control filtering, spreadsheet-safe CSV fields.                   |

Any unverified mutation, ambiguous create, origin mismatch, malformed live projection, unsupported
schema, non-durable journal outcome, or concurrent drift must fail closed with a nonzero result.

## Alternatives with Pros/Cons/Effort

| Alternative                                         | Pros                                                                                                      | Cons                                                                                                                          | Effort      | Decision                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------- |
| Dedicated live `presets` workflow                   | Smallest compatible architecture; native onboarding; preserves old plans; supports immediate convergence. | Diff and apply review are in one invocation unless a future checksum/artifact is added.                                       | Large       | **Recommend for v1.**                        |
| New sealed `lidarr-config-plan.v1` artifact         | Best offline/team review, checksum binding, durable resume semantics.                                     | New artifact validator, storage, history, presenter, and compatibility surface substantially exceed issue scope.              | Extra large | Follow-up after live workflow proves stable. |
| Extend `rfmedia.lidarr-plan.v2`                     | Reuses one command noun and some apply UI.                                                                | Breaks exhaustive numeric-target assumptions and couples shared-resource dependencies to artist/album history.                | Extra large | Reject.                                      |
| Quality profiles first; defer custom formats/naming | Faster initial merge.                                                                                     | Fails the issue title, scope, onboarding value, and acceptance criteria; profile writes also depend on complete format state. | Medium      | Reject as incomplete.                        |
| Built-ins only; defer configured packs              | Smaller validation surface.                                                                               | Config schema is an affected area and repeatable user-defined desired state is core value.                                    | Medium      | Reject as incomplete.                        |
| Read-only export with manual Lidarr changes         | Very low mutation risk.                                                                                   | Does not provide apply, idempotency, or repeatable automation.                                                                | Small       | Reject as incomplete.                        |
| Recyclarr/TRaSH or another SDK                      | Familiar external model.                                                                                  | No supported Lidarr coverage, adds transport/auth/dependency boundaries, and still leaves untyped APIs.                       | Large       | Reject.                                      |
| Remote community preset catalog                     | Rapid policy growth.                                                                                      | Supply-chain, drift, signing, provenance, and availability risks conflict with safe onboarding.                               | Extra large | Defer; local reviewed packs only.            |
| Automatic rollback                                  | Appears transactional.                                                                                    | Cannot restore server IDs, can overwrite concurrent changes, and rollback itself can fail.                                    | Large       | Reject; reconcile forward.                   |

## Recommended Task Breakdown

1. **Freeze policy and contracts:** pin the supported Lidarr fixture; approve three built-in
   payloads; define pack versions/digests, exact config schema, domain models, result schemas,
   limits, and stable errors.
2. **Project API resources:** add bounded custom-format/schema, rich quality-profile/schema, naming,
   naming-example, and impact projectors plus malformed-response tests.
3. **Extend the facade:** add generated-backed read/create/update methods, keep generated types
   private, convert PUT IDs internally, and update generated-operation/architecture checks.
4. **Build the pure engine:** resolve names, merge required unmanaged format items, validate
   dependencies and naming, calculate impacts, and produce byte-stable semantic diffs.
5. **Build offline discovery:** implement registry/config resolution and `list`/`show` human and
   machine output.
6. **Build live diff:** fetch fresh state, validate all pipelines as one preflight, render
   create/update/unchanged/retained and field-level changes, and prove zero mutations.
7. **Build apply safety:** add origin locking, approval, dry-run precedence, final drift checks,
   dependency ordering, no-retry mutations, read-back verification, journaling, interruption, and
   rerun convergence.
8. **Integrate UX:** implement deterministic human, JSON, YAML, and CSV output; errors; impacts;
   partial recovery; exact rerun commands; and exit behavior.
9. **Complete repository surfaces:** update example config, feature/plan docs, all three completion
   templates, test mocks, and compatibility gates.
10. **Verify acceptance:** run focused unit/integration tests, full typecheck/lint/build/test gates,
    `git diff --check`, markdown lint, completion parity, architecture checks, and
    `npm audit --omit=dev`.

Tasks 2 and the config portion of task 1 can proceed in parallel after the policy/domain contract
is fixed. Tasks 3–8 are dependency ordered. Do not split apply orchestration from its locking,
verification, and recovery tests.

## Key Decisions Needed

The recommendation resolves the architecture decisions as follows:

| Decision          | V1 answer                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Command model     | Dedicated `lidarr presets list/show/diff/apply`.                                                               |
| Built-ins         | Exactly `balanced@1`, `lossless@1`, and `space-saver@1`.                                                       |
| User packs        | Supported, strict, fully self-contained, and source-qualified.                                                 |
| Pack inheritance  | Not in v1.                                                                                                     |
| Identity/adoption | Exact normalized name; same-name valid resource is adopted after explicit diff.                                |
| Ownership         | Declared resources and profile policy fields; undeclared resources/scores retained; complete naming singleton. |
| Deletion/rename   | Not in v1; no prune or inferred rename.                                                                        |
| Apply ordering    | Custom formats, refreshed schema/IDs, quality profiles, naming.                                                |
| Failure policy    | Stop all later writes after failure, stale state, uncertainty, or journal failure.                             |
| Concurrency       | One local lock per canonical Lidarr origin plus per-write live comparison.                                     |
| Recovery          | Durable outcomes and forward convergence on rerun; no automatic rollback.                                      |
| Approval          | Default-no prompt; machine/non-TTY requires `--yes`; dry run always wins.                                      |
| Saved artifact    | Not in v1; add a distinct config-plan artifact later if required.                                              |
| Output            | Human plus complete versioned JSON, YAML, and fixed-row CSV.                                                   |
| Remote packs      | Not in v1.                                                                                                     |

Two product sign-offs remain mandatory before coding the built-in registry:

1. Approve the exact fixture-backed quality names/order/cutoffs, custom-format definitions/scores,
   and naming templates for each of the three packs.
2. Approve the minimum supported Lidarr capability/version floor and the expected incompatible
   server error contract.

These are not candidates for post-v1 deferral because opaque or placeholder curated policy would
defeat the issue's onboarding promise.

## Open Questions

- What exact Lidarr version and container fixture will be the compatibility floor?
- What exact wire shape does `/api/v1/config/naming/examples` return on that floor, and can a
  reliable candidate preview be produced only when a positive saved ID is supplied?
- Which quality/group semantic names and naming tokens are stable across the chosen supported
  version range?
- Which safe regex grammar is narrow enough for configured release-title/group conditions while
  still expressing the three approved built-in policies?
- Which existing persistence/locking primitive should back the origin-scoped apply lock and
  per-resource journal without coupling the workflow to `lidarr-plan.v2`?
- Can artist assignment counts and custom-format profile references be derived from already
  required collection reads, or is one additional bounded fresh read required?
- How should harmless server normalization be canonicalized per field so it does not cause
  perpetual drift while preserving behaviorally significant order?
- What stabilization deadline should classify an interrupted or timed-out in-flight mutation as
  `uncertain`?

Each question should be answered by a fixture, contract test, or explicit policy decision before
the relevant implementation task merges. None changes the recommended v1 product scope.
