# Lidarr Similar Artist Discovery Implementation Plan

Issue #203 introduces an independently usable Last.fm discovery path and a foreign-ID
`artist-add` handoff into the existing sealed plan/apply system. The read path performs one
bounded, attributed provider request in the `discovery` lane and never resolves Lidarr; the
optional handoff validates one visible MBID-backed rank and writes at most one plan. Apply owns
fresh resource/absence checks, one non-retried non-deferable create, durable possible-dispatch
evidence, and exact-MBID reconciliation. The implementation retains generated-client privacy,
static three-shell parity, and the scope boundaries owned by issues #204–#206 and #219.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-203/ (branch: issue-203-lidarr-discovery)

## Critically Relevant Files and Documentation

- `docs/plans/lidarr-similar-artist-discovery/feature-spec.md`: Authoritative behavior and scope.
- `docs/plans/lidarr-similar-artist-discovery/shared.md`: Architecture, patterns, and reading map.
- `packages/rfmedia-cli/AGENTS.md`: Package-specific TypeScript, testing, and architecture rules.
- `packages/rfmedia-cli/src/commands/lidarr-search.ts`: Sibling command and output precedent.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Discovery lane and safe retry ownership.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole generated Lidarr client boundary.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Closed v2 operation and evidence contracts.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Strict plan/history/claim implementation.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Apply orchestration and uncertainty policy.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Architecture ownership scanner.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Shell parity contract.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Operator mutation safety contract.

## Implementation Plan

### Phase 1: Independent Discovery and Lidarr Foundations

#### Task 1.1: Define discovery configuration and public contracts Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-similar-artist-discovery/feature-spec.md`
- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/lib/config.ts`
- `packages/rfmedia-cli/src/types/lidarr.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/types/discovery.ts`

Files to Modify

- `packages/rfmedia-cli/src/types/index.ts`
- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/lib/config.ts`
- `packages/rfmedia-cli/src/lib/config.test.ts`

Add immutable generated-independent discovery, attribution, recommendation, provider-failure, and
handoff contracts. Extend configuration with the exact optional
`discovery.lastfm.{apiKey,timeoutMs}` shape, strict unknown-key/type/bound validation, template
compatibility, and recursive secret redaction. Preserve the repository's eager template-resolution
behavior explicitly. Add only contract-critical configuration tests.

#### Task 1.2: Implement the fixed Last.fm boundary and scheduler seam Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-similar-artist-discovery/feature-spec.md`
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts`
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`
- `packages/rfmedia-cli/src/lib/lidarr/search.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`
- `packages/rfmedia-cli/src/lib/discovery/lastfm.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.test.ts`

Create the sole Last.fm Fetch owner with fixed HTTPS origin/method, no redirects, combined
caller/timeout cancellation, bounded fatal decoding, logical-error parsing, safe Retry-After,
atomic projection, validated Last.fm catalogue URLs, canonical optional MBIDs, and complete key
redaction. Generalize scheduler classification to a narrow safe structural error view and expose
`discovery-provider-unavailable` only through execution metadata. Retry only idempotent discovery
work; do not touch Lidarr circuits, cache, stale hints, or deferred mutation. Tests cover the trust
boundary and retry ownership, not a combinatorial HTTP matrix.

#### Task 1.3: Extend the private Lidarr facade without generated edits Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-similar-artist-discovery/feature-spec.md`
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

Expose strict root-folder, exact-MBID read-back, and artist-add domain methods through
`LidarrClientApi`. Construct the minimal writable artist body only inside `client.ts`, from an
authoritative exact Lidarr lookup plus sealed root/profile and fixed
unmonitored/no-search policy. Forward methods through resilience while keeping `addArtist`
non-retried and non-cached. Pin the already committed root-folder GET and artist POST operations in
offline generator/contract assertions; never edit generated source or refresh OpenAPI. Add focused
facade/projection/resilience tests in the existing colocated suites.

### Phase 2: Read-Only Discovery and Strict Add Plan

#### Task 2.1: Build the read-only discovery action Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/search.ts`
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`
- `packages/rfmedia-cli/src/lib/lidarr/search.ts`
- `docs/plans/lidarr-similar-artist-discovery/feature-spec.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/index.ts`

Validate seed and limit before dependency resolution, submit exactly one idempotent discovery-lane
task, remove the resolved seed, deduplicate MBID-first with conservative first-win fallback,
preserve provider order, assign contiguous visible ranks, and return attribution plus execution
metadata even for empty success. Prove the ordinary path makes one provider call and zero Lidarr
resolution/calls, including cancellation and empty results. Do not add provider caching,
`--allow-stale`, paging, a registry, or MusicBrainz calls.

#### Task 2.2: Add the strict foreign-ID artist-add plan family Depends on [1.1, 1.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`

Add a kind-first v2 `artist-add` subtype keyed by canonical `foreignArtistId`, with expected
absence, exact desired policy, Last.fm provenance, root/profile references, foreign-ID
history/results/failures, deterministic idempotency material, exact-key parsing, and unchanged v1
and existing v2 behavior. Resolve one selected visible recommendation only after MBID validation,
then perform fresh exact lookup, complete library, root-folder, quality-profile, and
metadata-profile reads. Return `already-present` without an artifact, or atomically write one
origin-bound plan. Mark add non-deferable; do not synthesize a numeric ID or create a deferred
executor. Tests cover round-trip/tamper, exact resource ambiguity, no-op, and one sealed entry.

### Phase 3: Non-Idempotent Apply Safety

#### Task 3.1: Integrate artist-add preflight, dispatch, and reconciliation Depends on [1.3, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-resources.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-entry-execution.ts`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/apply-target-types.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-resources.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`

Route `artist-add` by operation kind before numeric-target narrowing. Freshly revalidate exact MBID
absence/presence and every sealed resource: desired existing state is satisfied, absence is ready,
and conflicting identity/policy is drift. Persist possible-dispatch evidence while the claim is
owned before one `metadata-dependent`, `idempotent:false`, non-deferable POST. Reconcile response
or transport ambiguity by fresh exact-MBID read-back; proven desired presence succeeds, while
inconclusive or mismatched state is uncertain and stops admission. Resume may reconcile durable
uncertainty but must never blindly resend. Keep tests to the critical satisfaction, drift,
lost-response success, uncertainty, history/claim, and no-defer boundaries.

### Phase 4: Public CLI, Completion, and Architecture Contracts

#### Task 4.1: Wire discovery, add-plan handoff, and presentation Depends on [2.1, 2.2, 3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr-search.ts`
- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
- `docs/plans/lidarr-similar-artist-discovery/feature-spec.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`
- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`

Add `rfmedia lidarr discover --artist <name>` with default limit 15, maximum 100, and default
autocorrection plus `--no-autocorrect`. Conditional `--add <rank>` requires root folder, quality
profile, metadata profile, and plan file; it may accept existing Lidarr overrides but never
`--yes`, `--dry-run`, stale, provider selection, or Last.fm-key flags. Preserve successful
discovery in the result when handoff fails, and ensure discover can write only a plan, never POST.
Human output stays on stderr; JSON/YAML/CSV stay on stdout with mandatory attribution and a stable
summary row even when empty. A requested handoff failure renders exactly one successful discovery
document with a sanitized `handoff.status = "failed"` payload and then sets a nonzero process exit
code; it never emits a second machine document or discards recommendations. Extend apply
presentation for foreign-ID results and uncertainty.

#### Task 4.2: Update Bash, Zsh, and Fish with exact parity Depends on [4.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Add the same static discover leaf, value-taking options, and conditional add-plan flags to all
three shells. Preserve argument-aware file completion for the plan path and side-effect-free
generation. Extend the existing parity spec once to pin hierarchy, exact option set, value flags,
help order, and absence of config/client/network work; do not duplicate per-shell behavior tests.

#### Task 4.3: Enforce Last.fm fetch and artist-add mutation ownership Depends on [1.2, 1.3, 3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`

Register the exact Last.fm module as a distinct single Fetch owner and the dedicated artist-add
operation as the approved mutation owner. Retain all existing Plex/Lidarr generated-import,
handwritten-path, and mutation restrictions. Add focused scanner fixtures proving upper-layer or
second provider Fetch sites and unauthorized artist-create calls fail.

### Phase 5: Operator Documentation

#### Task 5.1: Document discovery and safe add Depends on [4.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/lidarr-search-lookup.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `ROADMAP.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/CHANGELOG.md`
- `rfmedia.example.yaml`
- `docs/README.md`

Document API-key templating, exact command/options, attribution and live-terms date, requested versus
resolved seed, raw similarity/rank/MBID semantics, no cache, zero-Lidarr default path, and every
output format. Document one sealed add-plan, fixed conservative policy, expected absence,
possible-dispatch evidence, no retry/defer, apply reconciliation, and recovery. Keep #204–#206 and #219
scope explicitly unshipped. Explain the repository's eager template-expansion caveat so the
example does not imply that an unresolved placeholder is invocation-lazy.

### Phase 6: Integrated Verification

#### Task 6.1: Run focused and repository-wide contract gates Depends on [4.2, 4.3, 5.1]

**READ THESE BEFORE TASK**

- `package.json`
- `packages/rfmedia-cli/package.json`
- `.github/workflows/rfmedia-cli.yml`
- `docs/plans/lidarr-similar-artist-discovery/feature-spec.md`

**Instructions**

Files to Modify

- `docs/plans/lidarr-similar-artist-discovery/parallel-plan.md`

Build `@rfmedia/common` first in a fresh worktree, then run the focused new Vitest files, exact
completion parity, architecture tests, and Lidarr codegen checks. Run rfmedia and repository
typecheck, build, full tests, coverage, formatting, markdownlint, and `git diff --check`; diagnose
failures against the owning task instead of weakening coverage. Generate all three completions to
confirm static output. Run `graphify update .` after source changes and record final verification
evidence in the PR template, not as invented plan status.

### Phase 7: Post-PR Roadmap Closeout

#### Task 7.1: Archive issue 203 with authoritative PR facts Depends on [6.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/roadmap-archive.md`
- `.github/pull_request_template.md`

**Instructions**

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`

Run only after the implementation branch has been pushed and its GitHub PR number is
authoritative. Remove #203 from both live roadmap locations, add #203 and the actual closing PR to
the Layer 2 shipped archive row/operator note, and update live issue counts from a fresh GitHub
audit. Keep #204–#206 and #219 open and do not imply their provider federation, threshold/cache,
configurable add-policy, or post-add scope shipped. Commit and push this closeout to the same PR,
then rerun markdown, formatting, and diff checks before formal review.

## Advice

- Treat ordinary discovery and add planning as separate dependency graphs; never resolve Lidarr on
  the default path.
- The Last.fm key is a query parameter, so never retain or surface a complete request URL in an
  error, cause, log, plan, history, or execution record.
- Route `artist-add` before numeric artist narrowing; a fake local ID would corrupt drift,
  history, sorting, and reconciliation semantics.
- Persist possible-dispatch evidence before POST and reconcile by exact MBID; absence after an
  ambiguous request is not proof that retrying is safe.
- Keep the existing v2 discriminator and exact allowlists so older binaries reject the additive
  operation fail-closed.
- Do not add a provider registry, provider cache, threshold/quarantine policy, configurable add
  defaults, post-add search, or MusicBrainz calls; those remain later issues.
- Completion changes are one contract: Bash, Zsh, Fish, and the parity test must land together.
