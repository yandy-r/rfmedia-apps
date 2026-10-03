# Pattern Research: 199-lidarr-artist-bulk-management

Issue #199 should extend the existing Lidarr sealed plan/apply architecture rather than introduce a
parallel mutation path. The closest precedent is artist monitoring: commands parse and render,
actions orchestrate fresh reads, the plan engine owns operation semantics and durable state, and the
private generated-client facade owns every HTTP detail.

## Architectural Patterns

- **Command/action separation:** `packages/rfmedia-cli/src/commands/lidarr.ts` owns Commander
  grammar, validation at the CLI boundary, lazy action imports, approval, rendering, output
  envelopes, and exit status. `packages/rfmedia-cli/src/actions/lidarr/plan.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/apply.ts` are framework-agnostic orchestration and return
  typed results without printing.
- **Stable facade over private generated code:** Only
  `packages/rfmedia-cli/src/lib/lidarr/client.ts` imports generated operations. Public actions
  depend on the narrow `LidarrClientApi`; generated DTOs, endpoint paths, and response envelopes do
  not escape the facade. `packages/rfmedia-cli/src/lib/lidarr/transport.ts` remains the single
  authenticated Fetch owner.
- **Strict domain projection:** `packages/rfmedia-cli/src/lib/lidarr/types.ts` validates unknown
  wire values and creates fresh domain objects declared in
  `packages/rfmedia-cli/src/types/lidarr.ts`. New profile and tag projectors should reject the
  entire malformed collection, validate positive safe IDs and bounded safe labels, normalize tag
  arrays, and never return generated objects by reference.
- **Intent-bearing client methods:** Follow `setArtistsMonitored()` in
  `packages/rfmedia-cli/src/lib/lidarr/client.ts`: validate inputs before transport and construct a
  minimal allowlisted editor body. Expose separate profile-assignment and tag-mode methods rather
  than a general artist-editor payload so monitoring, movement, deletion, and search fields are
  unrepresentable above the facade.
- **Default-deny resilience:** `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` explicitly
  allowlists idempotent reads for in-place retries and delegates mutations without retry. Add every
  facade method to the wrapper, allowlist only safe resource reads, never stale-cache
  mutation-authorizing reads, and keep plan/apply calls on the `local-only` lane with
  `retryAttemptsOverride: 0`.
- **Pure selection before planning:** Add the settled pure selector/resolver boundary at
  `packages/rfmedia-cli/src/actions/lidarr/selection.ts`. It should consume one fresh complete
  artist/resource snapshot, enforce mutually exclusive IDs, filters, or `--all`, resolve exact
  ID/name references, apply AND and all-of-tag semantics, sort by artist ID, reject zero matches,
  and check the cap only after resolving the complete cohort. Do not reuse paged or stale-capable
  `packages/rfmedia-cli/src/actions/lidarr/list.ts`.
- **Operation-definition registry:** `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` centralizes
  monitoring canonicalization, risk, idempotency, live classification, deferred payloads,
  execution, and replay matching in `LidarrMutationOperationDefinition`. Add profile and tag
  definitions through the same registry so apply remains operation-neutral and unsupported kinds
  fail closed.
- **Versioned sealed artifacts:** Preserve the exact v1 types, parser, canonical representation,
  checksum bytes, and monitoring behavior in
  `packages/rfmedia-cli/src/types/lidarr-plan.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`. Dispatch readers by version and write strict
  v2 discriminated plans containing canonical selection plus operation-specific entries. Never
  silently reinterpret or rewrite a v1 artifact.
- **Canonical desired state:** The current builder sorts artists, derives review counts, computes
  operation-owned idempotency keys, and seals fixed-key JSON with SHA-256. V2 should additionally
  sort and deduplicate all resource/tag arrays and include selection, resolved IDs/labels,
  before/after values, deltas, risk, order, and idempotency keys in the seal.
- **Hardened local persistence:** Reuse the exact-key and sensitive/prototype-key guards, bounded
  parsing, canonical-origin checks, no-follow file opens, private modes, atomic artifact writes,
  JSONL history, resume selection, and exclusive claims already implemented in
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`.
- **Per-target durable apply:** `packages/rfmedia-cli/src/actions/lidarr/apply.ts` preflights all
  entries, treats dry-run as claim/history/mutation-free, acquires an exclusive claim for real
  apply, reclassifies each target immediately before admission, asserts claim ownership before the
  remote call, records each outcome synchronously, and stops later admissions on drift,
  cancellation, lost ownership, or uncertainty.
- **Verification is a required extension:** Current monitoring apply records `succeeded` after an
  accepted editor response without a follow-up read. For profiles and tags, acceptance (including
  HTTP 202) is not success evidence. Add a generated targeted artist read and verify the managed
  postcondition before durable success; an unreconciled post-dispatch result must become uncertain
  and stop later admissions.
- **Exact resume/defer identity:** Reuse operation-specific executor names, credential-free exact
  payload validation, idempotency keys, and strict operation/payload matching from
  `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts` and the plan definitions. Resume must
  reread live state and never blindly replay a possibly committed response-loss mutation.
- **Architecture enforcement:** Extend
  `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and its Node tests. Existing rules
  already reject upper-layer generated imports, generated re-exports, handwritten Lidarr API paths,
  and extra Fetch owners; issue #199 also needs a rule confining new mutation calls to the facade
  and registered operation owner.

## Code Conventions

- **ESM imports:** The package is `"type": "module"` with NodeNext resolution. Every local import
  uses a `.js` specifier, including imports from TypeScript files; type-only dependencies use
  `import type`. Examples are in `packages/rfmedia-cli/src/lib/lidarr/client.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/plan.ts`.
- **Strict TypeScript:** `packages/rfmedia-cli/tsconfig.json` enables `strict`,
  `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `isolatedModules`, and
  `verbatimModuleSyntax`. Avoid `any`; narrow `unknown`, guard indexed access, and use exhaustive
  discriminated unions for plan versions, operations, entries, tag modes, findings, and outcomes.
- **Immutable contracts:** Public/domain data uses `readonly`, immutable array types,
  `Object.freeze()`, and `satisfies` where a literal must retain narrow types. See the risk object
  and operation definition in `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`.
- **Omit absent fields:** Existing code uses conditional object spreads rather than serializing
  undefined optional values. This is important for exact editor bodies, deferred payloads,
  canonical checksums, and strict key validation.
- **Deterministic collections:** Copy before sorting, use `Set`/`Map` for uniqueness and lookup, and
  emit ascending numeric order. Tags are mathematical sets across construction, comparison,
  checksum, request, preview, and verification.
- **Export documentation:** Exported functions and interfaces use short JSDoc descriptions and
  parameter/result documentation. Keep operation-specific pure helpers small rather than expanding
  command or apply functions with inline profile/tag logic.
- **Lazy command dependencies:** Command handlers dynamically import actions and formatters after
  parsing. Preserve this startup pattern when adding `artist-profiles` and `artist-tags`.
- **Duplicate validation at trust boundaries:** Commander should express simple mandatory options
  and conflicts, but action and facade APIs must repeat semantic validation because tests and
  embedders call them directly.
- **No new dependency:** Native maps/sets, existing guards, Node crypto/fs, Commander,
  `console-table-printer`, `picocolors`, and shared formatters cover the feature.

## Error Handling

- **CLI syntax errors:** Use Commander's `InvalidArgumentError` for parser failures and
  `MissingRequiredArgumentError` from `packages/rfmedia-cli/src/lib/errors.ts` for missing required
  option groups. Commander conflicts are helpful UX but do not replace action validation.
- **Plan semantic errors:** Use `LidarrPlanValidationError` for missing/conflicting selectors,
  duplicate or unknown IDs, zero matches, ambiguous/missing resource references, invalid tag modes,
  cap overflow, unsupported versions, and operation/entry/risk/idempotency inconsistency.
- **Artifact errors:** Preserve `LidarrPlanArtifactError` stable codes for unsafe paths, oversize,
  malformed input, checksum mismatch, overwrite, empty files, and I/O. Do not repair untrusted plan
  files.
- **Live drift:** Extend `LidarrPlanStaleError` findings with discriminated target/resource codes.
  Missing desired resources block the whole plan before writes; managed artist drift blocks
  admission. Profile classification permits reviewed-before/desired partial convergence, tag
  add/remove tolerate unrelated tag changes, and tag set/clear require exact reviewed state.
- **Facade/transport errors:** `packages/rfmedia-cli/src/lib/lidarr/errors.ts` carries stable code,
  operation, status, retryability, and retry-after metadata. Facade input/projection/postcondition
  problems are non-retryable `LidarrValidationError`; retryable pre-dispatch failures may be
  deferred.
- **Post-dispatch ambiguity:** Never classify an accepted or timed-out mutation as definite success
  without a fresh verification read. Preserve whether dispatch and verification occurred, store
  before/after/observed evidence when available, mark unresolved outcomes uncertain, and print a
  safe `--resume` command.
- **Sanitization:** Existing client tests prove raw bodies, causes, keys, and internal client state
  stay out of errors. New labels must be bounded and reject control/bidirectional characters; plans,
  history, deferred payloads, logs, and outputs must never contain credentials or raw responses.
- **Exit behavior:** `packages/rfmedia-cli/src/commands/lidarr.ts` sets a failing exit code for
  failed/partial apply while returning checked/completed results normally. Machine failures go
  through the same single-document formatter contract as successes.

## Testing Approach

- **Co-located Vitest suites:** Keep tests beside production modules. The primary precedents are
  `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`,
  `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`,
  `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`, and
  `packages/rfmedia-cli/src/commands/lidarr.test.ts`.
- **Typed facade mocks:** Extend
  `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`; its mapped type preserves
  every `LidarrClientApi` signature and supplies safe resolved defaults. Add resource factories to
  `packages/rfmedia-cli/src/actions/test-helpers/lidarr-fixtures.ts`. Actions should mock this seam,
  never generated SDK functions.
- **Hoisted module seams:** Action/command suites use `vi.hoisted()` state followed by `vi.mock()`
  so scheduler, resolver, prompt, formatter, and signal behavior are deterministic. Use
  `vi.clearAllMocks()` to preserve default implementations; avoid blanket `vi.resetAllMocks()`.
- **Injected deterministic dependencies:** Reuse `LidarrPlanBuildDependencies` for UUID, time,
  host, user, cwd, and CLI version, plus `LidarrPlanClaimDependencies` for ownership races.
  Temporary plan/history/database directories use `mkdtemp()` and `afterEach()` cleanup.
- **Pure table-driven tests:** Test selectors, exact name/ID resolution, profile classification,
  and tag algebra without network/filesystem state. Cover ambiguity, unknowns, selection conflicts,
  AND/all-of filters, zero matches, cap overflow, partial convergence, unrelated delta drift,
  set/clear drift, no-ops, and deterministic sorting.
- **Facade boundary tests:** Follow the injected Fetch tests in
  `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`. Assert exact generated method/path/body,
  successful 202 with ignored body, malformed projections, input rejection before Fetch,
  already-aborted and in-flight abort identity, two-client origin/key isolation, and absence of
  unrelated editor fields.
- **Schema and artifact tests:** Extend
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` with v1 byte/checksum/apply regression
  fixtures and v2 round-trip, canonical ordering, tamper, exact-key, prototype/sensitive-key,
  operation-entry-risk consistency, resource deletion, and private atomic I/O cases.
- **Apply lifecycle tests:** Preserve the current transition-focused style: zero-write preflight,
  dry-run without history/claim/deferred rows, satisfied without editor call, late drift stopping
  later admissions, one-ID mutation, post-write verification, retryable defer, non-retryable
  failure, response-loss reconciliation, uncertain stop, cancellation, history-write uncertainty,
  exact deferred matching, and resume skips.
- **Command/output tests:** Extend `packages/rfmedia-cli/src/commands/lidarr.test.ts` for command
  hierarchy, conflicts, repeatable collectors, action forwarding, bare-subcommand no-network help,
  20-row versus verbose rendering, JSON/YAML/CSV full-cohort parity, stdout silence in text mode,
  machine `--yes`, interactive review ID/checksum binding, tag replacement authorization, and exit
  codes.
- **Architecture/codegen tests:** Update
  `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`,
  `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`, and the offline generator tests
  so required profile/tag/editor contracts and mutation ownership cannot drift silently.
- **Shell parity tests:** Update all three static generators:
  `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`.
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` already locks the Lidarr
  operation tree, shared option parity, cap candidates, plan path completion, apply options, and
  zero-network static generation. Extend those assertions for both new operations and every
  selector/change/safety flag.

## Patterns to Follow

1. Define narrow immutable profile/tag domain types and strict projectors before exposing new
   facade methods.
2. Keep generated imports and all artist-editor body construction in
   `packages/rfmedia-cli/src/lib/lidarr/client.ts`; keep Fetch ownership in transport.
3. Implement fresh pure selection/reference resolution independently of `lidarr list`, then build
   separate `artist-profile-assignment` and `artist-tag-mutation` operations.
4. Preserve the exact v1 parser/checksum path and add a strict version-dispatched v2 union; move
   producers to v2 without rewriting existing artifacts.
5. Put canonicalization, risk, entry construction, idempotency, classification, execution,
   deferred validation, and replay matching in registered operation definitions.
6. Reuse safe artifact/history/claim storage and the generic apply lifecycle. Add whole-plan
   resource preflight, targeted pre-admission reads, one-artist mutations, targeted verification,
   and durable evidence before the next admission.
7. Keep dry-run entirely mutation-, claim-, history-, and deferred-write-free. Require the existing
   review/approval flow and add independent `--allow-tag-replacement` authorization for set/clear.
8. Render human review to stderr with an explicit 20-row bound and operation-aware change/no-op or
   removal language; emit exactly one complete machine document to stdout.
9. Update command grammar, Bash/Zsh/Fish completions, parity tests, architecture gates, generated
   contract checks, feature docs, and regression tests as one command-surface change.
10. Treat a verified postcondition—not an HTTP status or response body—as success. Stop admission
    and direct the operator to exact resume whenever dispatch outcome cannot be reconciled.
