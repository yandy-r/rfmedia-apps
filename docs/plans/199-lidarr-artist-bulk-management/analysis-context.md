# Context Analysis: 199-lidarr-artist-bulk-management

## Executive Summary

Issue #199 extends the existing sealed Lidarr plan/apply workflow; it does not add a direct artist
editor. Two read-only producers, `lidarr plan artist-profiles` and
`lidarr plan artist-tags`, resolve a fresh complete cohort, freeze exact before/after state, and
write strict `rfmedia.lidarr-plan.v2` artifacts. `lidarr apply` remains the only remote write path,
executes one artist per editor request, verifies each managed postcondition with a fresh targeted
read, and durably records the outcome before admitting the next artist.

The feature supports quality and metadata profile assignment together, plus exactly one tag mode
per plan: add, remove, set, or explicit clear. Selection requires exactly one of exact IDs,
AND-composed filters, or `--all`; repeated tag selectors use all-of semantics. Planning never uses
list pagination, stale cache, omitted-selector defaults, fuzzy references, or cap truncation.

Version 1 monitoring plan bytes, checksums, parsing, apply behavior, history identity, and resume
behavior are immutable. All current producers, including monitoring, move to v2. Existing
authenticated transport, private generated-client facade, plan artifact, origin, approval, claim,
history, scheduler, deferred-intent, cancellation, and resume boundaries remain authoritative.
No new dependency, database migration, direct Fetch owner, handwritten endpoint, or general editor
payload is allowed.

`feature-spec.md` and `shared.md` are authoritative where earlier research differs. In particular,
the settled contract rejects IDs-plus-filters composition, grouped multi-artist writes, combined
profile/tag plans, implicit tag creation, and ambiguous empty replacement syntax.

## Architecture Context

The required dependency direction is:

```text
commands/lidarr.ts
  -> actions/lidarr plan producers or apply
    -> pure artist selection + operation policy
      -> versioned plan engine
        -> stable LidarrClientApi
          -> private generated operations
            -> sole authenticated transport
              -> Lidarr
```

- **Command boundary**: Commander grammar, simple conflicts, lazy action imports, human rendering,
  structured envelopes, interactive dry-run-before-confirmation, replacement authorization, and
  exit behavior remain in `commands/lidarr.ts`. Actions repeat safety invariants for non-CLI
  callers.
- **Plan producers**: Profile and tag actions fetch fresh artists and only the required resource
  lists, call pure selection/resolution helpers, build operation-specific entries, seal the plan,
  and write the artifact. Planning performs no editor calls.
- **Pure selection**: A focused `artist-selection.ts` should own selector validation, exact
  ID/name resolution, AND/all-of predicates, deterministic sorting, complete-cohort cap checks,
  zero-match rejection, and tag set algebra. It performs no I/O, paging, rendering, or mutation.
- **Operation policy**: Monitoring, profile assignment, and tag mutation definitions own
  canonical state, entry construction, risk, change detection, stale classification, idempotency,
  minimal execution, verification, deferred payload validation, and replay matching.
- **Plan infrastructure**: `plan-engine.ts` owns version dispatch, exact schemas,
  canonicalization/checksums, safe artifact I/O, history, claims, and resume selection. It remains
  operation-neutral and must preserve the exact v1 implementation.
- **Facade boundary**: Only `lib/lidarr/client.ts` may import generated operations or construct the
  artist-editor body. It exposes bounded domain projections and intent-bearing profile/tag
  methods; generated DTOs and response envelopes do not escape.
- **Transport boundary**: `transport.ts` remains the sole authenticated production Fetch owner,
  preserving canonical-origin validation, header-only API-key injection, redirect rejection,
  timeout/cancellation composition, and bounded responses.
- **Apply lifecycle**: Apply performs one fresh whole-plan artist/resource preflight, classifies
  every relevant entry without writes, returns mutation-free dry-run results, claims the plan for
  real execution, revalidates one target immediately before admission, sends one minimal
  `artistIds: [id]` request, verifies with `getArtist(id)`, and persists the authoritative outcome
  before continuing.
- **Durable recovery**: Existing JSONL history and the schema-v10
  `lidarr_deferred_intents` table support new exact executor names and credential-free payloads
  without migration. Resume exact-matches origin, operation, normalized payload, and idempotency
  key before live reconciliation.
- **Execution policy**: All profile/tag work remains in the `local-only` scheduler lane. Fresh
  mutation-authorizing reads disable stale fallback and in-place retries. Mutations are never
  automatically retried after a possibly dispatched request.

## Critical Files Reference

- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`: Authoritative product, safety,
  compatibility, output, completion, and scope contract.
- `docs/plans/199-lidarr-artist-bulk-management/shared.md`: Consolidated repository map, patterns,
  and mandatory implementation references.
- `docs/plans/199-lidarr-artist-bulk-management/research-recommendations.md`: Settled command,
  selector, schema, tag, verification, risk, and task-order decisions.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Add both plan leaves, option groups/conflicts,
  rendering, replacement authorization, and machine projections.
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`: Lock command hierarchy, forwarding,
  dry-run-before-approval, machine output, stdout purity, and exit behavior.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`: Existing fresh monitoring-plan and artifact
  orchestration pattern; monitoring producer must move to v2.
- `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`: Fresh selection, cap, zero-match, all-no-op,
  and no-mutation planning tests.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Generic preflight, claims, per-target
  admission, history, deferred intent, cancellation, verification, and resume lifecycle.
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`: Primary state-transition regression
  surface for stale, satisfied, deferred, failed, uncertain, cancellation, and resume outcomes.
- `packages/rfmedia-cli/src/actions/lidarr/list.ts`: Predicate precedent for monitored/profile and
  repeated-tag all-of semantics only; its paging and stale-cache paths are forbidden for mutation
  authority.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: Public action exports for the new producers.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`: Typed facade mock that
  must implement every new `LidarrClientApi` method.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-fixtures.ts`: Stable artist, profile, and
  tag fixtures with normalized safe defaults.
- `packages/rfmedia-cli/src/types/lidarr.ts`: Generated-independent immutable artist/profile/tag
  domain types.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Exact v1 plus strict v2 plan, operation,
  selection, entry, stale-finding, apply-result, and evidence unions.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Unknown-to-domain projectors; add bounded
  profile/tag collections and normalize artist tag arrays to sorted unique positive safe IDs.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole generated importer; add resource lists,
  targeted artist read, minimal profile assignment, and explicit tag-mode mutation.
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`: Assert exact generated calls and bodies,
  successful `2xx`/`202`, ignored bodies, cancellation, malformed-response rejection, secret
  isolation, and absence of unrelated editor fields.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Explicitly delegate every new facade method;
  retry only safe reads and never stale-cache mutation authority.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`: Delegation, retry allowlist, cache, and
  mutation no-retry contract.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Strict v1/v2 dispatch, operation registry,
  canonical checksums, artifacts, history, claims, resume, and executor creation.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: V1 byte/checksum compatibility, v2
  strictness, tamper/sensitive-key rejection, operation invariants, and persistence tests.
- `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts`: Exact deferred intent validation,
  claims, replay, and executor registry; no schema change.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Shared `local-only` admission, cancellation,
  and retry metadata.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts`: Sole authenticated Fetch owner and
  credential/origin boundary.
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`: Private generated operations already
  containing all required endpoints.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`: Extend offline required-operation and
  drift assertions; normal implementation does not refresh the OpenAPI snapshot.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Extend private generated-import,
  handwritten endpoint, exactly-one-Fetch, and mutation-owner architecture policy.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts`: Add both plan leaves and the
  full static selector/change/safety surface together.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Exact cross-shell hierarchy,
  flag, and value-candidate parity gate.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Document v2 writes, v1 compatibility,
  selectors, risks, replacement approval, verification, and uncertain recovery.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`: Document new required generated
  contracts and narrow facade ownership without exposing generated modules.
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`: Keep profile/tag mutations in
  `local-only` and correct stale “future mutation” wording.
- `packages/rfmedia-cli/README.md` and `CHANGELOG.md`: Add operator examples and `[Unreleased]`
  behavior without claiming a release.
- `ROADMAP.md` and `docs/roadmap-archive.md`: Record shipped state only after verified PR/merge
  evidence exists.

## Patterns to Follow

- **Strict command/action separation**: Commands parse, approve, render, and set exit state;
  actions return typed results and never print.
- **Stable facade over private codegen**: Generated imports stay in `client.ts`, Fetch stays in
  `transport.ts`, and actions mock only `LidarrClientApi`.
- **Whole-response runtime trust boundary**: Validate positive safe IDs, bounded non-empty safe
  labels, collection bounds, and artist tag arrays; reject malformed collections rather than
  partially accepting mutation authority.
- **Intent-bearing mutations**: Expose profile assignment and tag-mode methods, not
  `editArtist(payload)`. Construct only:

  ```text
  artistIds + requested qualityProfileId and/or metadataProfileId
  artistIds + tags + explicit applyTags
  ```

- **Pure deterministic selection**: Exactly one selector mode; fresh complete data; no paging,
  stale fallback, fuzzy matching, implicit all, or truncation. Sort targets by ascending artist ID.
- **Exact resource resolution**: Positive decimal means ID; other text is trimmed,
  case-insensitive exact name/label; `name:<value>` forces name interpretation. Unknown or
  ambiguous input fails with bounded `name (id)` choices.
- **Canonical set semantics**: Tag IDs are unique sorted sets in plans, checksums, comparisons,
  payloads, output, and verification.
- **Versioned sealed artifacts**: Dispatch by exact version, preserve v1 canonical bytes and
  checksum, write all current plans as v2, reject unknown keys/kinds/versions, and never rewrite a
  v1 artifact.
- **Operation-owned state semantics**: Keep profile partial convergence, tag delta tolerance, and
  tag replacement exactness inside typed operation definitions rather than branching throughout
  apply.
- **Per-target durable execution**: Preflight all, revalidate one, write one, verify one, persist
  one, then admit the next. “Bulk” describes the reviewed cohort, not a shared HTTP transaction.
- **Reconciliation before replay**: Any uncertainty after dispatch requires a fresh targeted read.
  Resume replays only exact deferred identity and never blindly duplicates a lost-response write.
- **Typed tests at owning layers**: Table-drive pure selector/resource/tag/classifier semantics;
  assert exact bodies at the facade; test lifecycle transitions in apply; use
  `vi.clearAllMocks()` and package fixture helpers.
- **Executable architecture policy**: Extend codegen and architecture gates without weakening
  private imports, endpoint bans, Fetch ownership, or mutation ownership.
- **Static completion parity**: Update Bash, Zsh, Fish, and parity tests as one change; never
  perform remote resource lookup from completion.

## Cross-Cutting Concerns

- **Selector safety**: Require exactly one of unique known IDs, one or more filters, or `--all`.
  Filters combine with AND and repeated `--select-tag` is all-of. Resolve the full cohort before
  enforcing default 25 and hard 1,000 caps. Zero matches writes no plan; a non-empty all-no-op
  cohort writes an auditable plan.
- **Profile semantics**: Require quality, metadata, or both. Unrequested dimensions are unmanaged
  and omitted from the request. Managed fields are `satisfied` at desired, `ready` when each is at
  reviewed-before or desired with work remaining, and `drifted` at any third value. Profile
  clearing is unsupported.
- **Tag semantics**: Add is union, remove is difference, set is exact replacement, and clear is
  explicit empty replacement. Add/remove/set require non-empty unique tags; clear accepts none.
  Add/remove tolerate unrelated concurrent tags; set/clear require exact before or desired state.
- **Risk and approval**: Profiles are medium risk, tag add/remove low risk, tag set/clear high risk.
  Set/clear must prominently list removals and require `--allow-tag-replacement` in addition to
  `--yes` for non-interactive execution.
- **Dry-run purity**: Apply dry-run validates schema, checksum, origin, resources, history/resume,
  and live artists, but creates no claim, history row, deferred intent, or editor request.
- **Write evidence**: Any successful `2xx`, including observed `202`, means accepted only. Ignore
  the response body and require a fresh targeted read before durable success.
- **Failure admission**: Initial missing resources/artists or managed-state drift blocks all
  writes. Late drift, lost claim, post-dispatch cancellation, failed reconciliation, or history
  uncertainty stops later admissions. Retryable confirmed pre-write failures may defer.
- **Resource lifecycle**: Desired resource deletion blocks the run before writes. Rename of the
  same stable ID updates review context and warns; it never redirects intent.
- **Output contract**: Machine modes emit exactly one complete document on stdout; human review,
  diagnostics, and progress stay on stderr. Human text shows 20 entries by default and all under
  global `--verbose`; artifacts and JSON/YAML/CSV always retain the complete cohort.
- **Untrusted text**: Bound labels and reject terminal/control/bidirectional characters. Verify CSV
  formula-prefix neutralization. Never persist credentials, headers, raw bodies, generated DTOs,
  or credential-bearing URLs.
- **Artifact trust**: SHA-256 is an integrity checksum, not an author signature. Preserve private
  `0600`, no-follow, atomic no-overwrite storage, canonical-origin binding, approval, and expected
  plan ID/checksum checks.
- **Performance**: Planning fetches complete artists once plus required resource lists. Apply uses
  one whole-list preflight and targeted reads thereafter. Measure 25/100/1,000 cohorts before
  considering batching or altered defaults.
- **Compatibility**: No database migration is needed. Existing history and deferred storage remain
  operation-generic. Existing v1 monitoring plans remain readable, applicable, and resumable.
- **Documentation and release**: Update canonical Lidarr guides, package README, changelog,
  completions, and architecture/codegen contracts. Dependency-advisory remediation is a separate
  security child issue governed by release policy, not feature-scope dependency churn.

## Parallelization Opportunities

1. **V1/v2 contract lane**: Preserve v1 and add strict v2 types, parser/canonicalizer, checksums,
   operation/entry unions, stale findings, and plan-engine tests.
2. **Facade/projection lane**: Add bounded resource projections, normalized artist tags, generated
   resource/targeted reads, minimal mutations, resilience forwarding, client tests, and required
   generated-contract checks.

These two foundation lanes can proceed independently. After their domain contracts stabilize:

- **Selection lane**: Implement pure selector modes, exact resource resolution, predicates,
  ordering, caps, zero-match, and tag algebra against the stable domain types.
- **Architecture-gate lane**: Extend generated contract and architecture audit fixtures without
  touching plan/apply behavior.

The convergence sequence is:

1. operation definitions and profile/tag plan producers consume v2, facade, and selection;
2. generic apply consumes operation definitions plus targeted facade reads and verification;
3. CLI/rendering and completion parity consume stable action/result contracts;
4. documentation consumes the verified command and output surface;
5. comprehensive validation consumes all integrated lanes.

Tests belong to each owning lane. Avoid parallel ownership of `plan-engine.ts`, `apply.ts`,
`commands/lidarr.ts`, or completion templates. PR creation, review/fix, CI, squash merge, issue
closure, ROADMAP archival evidence, and worktree cleanup remain sequential delivery steps.

## Implementation Constraints

- Use Node.js 22, TypeScript ESM/NodeNext, explicit `.js` relative imports, strict typing, and no
  `any`.
- Add no runtime/development dependency, SDK, schema library, workflow engine, job runner,
  database table, migration, rollback framework, or dynamic completion service.
- Keep generated modules private, transport as the only authenticated Fetch owner, and all
  handwritten `/api/v1/` paths forbidden.
- Use only checked-in generated operations. Extend offline required-operation checks; do not
  refresh or edit the OpenAPI snapshot during normal implementation.
- Preserve exact v1 parser/canonicalizer/checksum/history/resume behavior. V2 is a strict
  discriminated union; older plans are never upgraded in place.
- Keep profile and tag plans separate. A profile plan may manage quality, metadata, or both; a tag
  plan has exactly one of add/remove/set/clear.
- Keep IDs, filters, and `--all` mutually exclusive. Do not add IDs-plus-filters intersections,
  any-tag selectors, free-form expressions, path/genre/date/statistics filters, or implicit all.
- Do not create tags, clear profiles, combine profile/tag mutations, send multiple artist IDs,
  add a direct mutation command, add a force-stale bypass, or automatically replay deferred work.
- Keep default cap 25, hard cap/entry limit 1,000, artifact/history limit 10 MiB, deterministic
  artist order, and `local-only` execution.
- Keep editor bodies allowlisted and unable to express monitoring, root movement, file movement or
  deletion, import-list exclusion, searches, or other unrelated fields.
- Keep plans, history, deferred payloads, logs, and machine output secret-free and bounded.
- Update Bash, Zsh, and Fish together and prove parity.
- Validate focused tests first, then codegen drift, architecture gates, package typecheck/tests/
  build, formatting/markdown, integration/regression behavior, and `git diff --check`.
- Final delivery uses `.github/pull_request_template.md`, includes exact validation outcomes and
  `Closes #199`, addresses review findings, waits for green CI, squash-merges, verifies issue
  closure, and cleans the branch/worktree.

## Key Recommendations

1. Freeze `feature-spec.md` as the implementation contract and treat older conflicting research as
   superseded.
2. Build the v1-preserving/v2-writing plan contract and the narrow facade/projection contract in
   parallel, with focused tests before orchestration changes.
3. Add one pure selector/resolver module that receives fresh complete data and returns an exact,
   sorted, cap-checked cohort plus canonical selection context.
4. Generalize only the operation-definition seam needed by monitoring, profiles, and tags; keep
   artifact/history/claim infrastructure generic and avoid a plugin framework.
5. Implement `artist-profiles` and `artist-tags` as read-only plan producers; keep `lidarr apply` as
   the sole editor caller above the facade.
6. Make profile managed-field and tag mode-specific classification exhaustive and table-tested,
   including partial convergence, unrelated delta-tag changes, replacement drift, and all-no-op.
7. Close the current acceptance gap: one-ID request, accept any `2xx`, ignore its body, targeted
   verify, durable outcome, then continue.
8. Preserve exact deferred/resume identity and stop later admissions whenever post-dispatch state
   or durable history cannot be established.
9. Add operation-aware human/machine output, destructive replacement authorization, static
   completion parity, and copy-pasteable recovery guidance.
10. Extend architecture/codegen gates and run the full repository lifecycle through review, green
    CI, squash merge, issue closure, and cleanup before marking #199 shipped.
