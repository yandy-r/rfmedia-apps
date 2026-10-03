# Lidarr Generated Client Implementation Plan

Replace the temporary handwritten Lidarr endpoint layer with a private, committed SDK generated
from a complete immutable official OpenAPI snapshot. Preserve `LidarrClientApi`, command behavior,
domain projections, and error semantics while moving all final-request trust and resource policy to
one hardened Fetch transport. Make regeneration deterministic and offline, isolate the only
networked refresh workflow, and enforce the generated/manual boundary in tests and architecture
checks. Complete the work through documentation, package inspection, review, green CI, squash
merge, issue closure, and dedicated-worktree cleanup.

## Critically Relevant Files and Documentation

- `docs/plans/lidarr-generated-client/feature-spec.md`: Accepted scope, decisions, and merge stops.
- `docs/plans/lidarr-generated-client/shared.md`: Architecture, patterns, and must-read index.
- `docs/plans/lidarr-generated-client/analysis-integration.md`: Exact toolchain, CI, and package constraints.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Stable facade and current handwritten request layer.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Private credentials and runtime projection guards.
- `packages/rfmedia-cli/src/lib/lidarr/errors.ts`: Stable sanitized error contract.
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`: Existing compatibility and adversarial baseline.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Existing network-boundary scanner.
- `packages/rfmedia-cli/package.json`: Node floor, scripts, and generator dependency.
- `.github/workflows/rfmedia-cli.yml`: Node 22 validation workflow.
- `packages/rfmedia-cli/docs/plans/lidarr-integration-foundation.md`: Layer-1 compatibility baseline.
- `.github/pull_request_template.md`: Required pull-request body and evidence contract.
- `ROADMAP.md`: Canonical issue progress record.

## Implementation Plan

### Phase 1: Prove and Freeze the Generator

#### Task 1.1: Verify the Generator Runtime and Exact Pins Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-generated-client/feature-spec.md`
- `docs/plans/lidarr-generated-client/research-external.md`
- `docs/plans/lidarr-generated-client/analysis-integration.md`
- `packages/rfmedia-cli/package.json`

**Instructions**

Files to Create

- `docs/plans/lidarr-generated-client/generator-spike.md`

Files to Modify

- `packages/rfmedia-cli/package.json`
- `package-lock.json`

Run `@hey-api/openapi-ts@0.93.0` under supported Node 22 and record its actual NodeNext imports,
bundled Fetch configuration, four generated operation names, result/error envelope, redirect
behavior, injected-Fetch call shape, and two-client isolation. Record the exact
`@hey-api/client-fetch` plugin/runtime version embedded by the generator; if it has no separately
meaningful version, record its generator/lockfile source plus hashes of the emitted bundled runtime
files. Carry that reproducible identity into the manifest and third-party notice. Record the full
TsArr rejection evidence without adding it: `tsarr@2.12.0`, engine `>=24.16.0`, Node 22 smoke result,
global two-client isolation failure, redirect behavior, and rejection conclusion. Exact-pin the
generator as a workspace development dependency; with explicit `bundle: true`, add no redundant
runtime dependency. If the spike fails per-instance custom Fetch, `.js` imports, or bounded
reconstructed-response compatibility, stop and record the failure before selecting exact-pinned
`openapi-typescript@7.13.0` plus `openapi-fetch@0.17.0`. Do not raise the Node floor, add Bun, use
version ranges, or add lifecycle hooks. Validate the lockfile and a Node 22 mocked request/import
probe.

#### Task 1.2: Add Immutable OpenAPI Inputs and Configuration Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-generated-client/generator-spike.md`
- `docs/plans/lidarr-generated-client/analysis-architecture.md`
- `docs/plans/lidarr-generated-client/research-security.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/openapi/lidarr-v1.json`
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`
- `packages/rfmedia-cli/openapi-ts.config.mjs`

Files to Modify

- None.

Commit the exact official snapshot from `Lidarr/Lidarr` commit
`3e2858439ff35b372d0af00bcea1b0a357572d26`. Add a timestamp-free manifest containing repository,
full commit, source path and pinned URL, Git blob SHA, exact-byte SHA-256, OpenAPI version, exact
tool/config versions, and explicit bundled-client mode. Configure one complete private Fetch SDK
using only the local snapshot, package tsconfig, `.js` NodeNext imports, and a fixed generated output
location. Prove OpenAPI 3.0.4, local-only references, both security schemes, the four required GET
paths, and matching hashes before generation. Bootstrap-download only the commit-pinned allowlisted
path, independently compute the Git blob and exact-byte hashes before committing it, and reject any
mismatch with the recorded upstream object.

#### Task 1.3: Implement Atomic Offline Generation and Drift Checking Depends on [1.2]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-generated-client/analysis-patterns.md`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`

**Instructions**

Files to Create

- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/generated/`

Files to Modify

- None.

Generate into a fresh temporary directory, validate the complete output and stable machine-owned
headers, and only then replace the exact generated directory in write mode. Check mode must compare
sorted relative paths, entry types, and bytes without mutating the checkout, rejecting changed,
missing, extra, symlink, and non-file entries with an exact repair command. Resolve paths from the
package, reject destination escape, preserve the prior tree on failure, and keep normal generation
offline. Add fixture tests for hashes/config drift, deterministic reruns, path confinement, atomic
failure, every discrepancy class, sorted redacted diagnostics, and worktree immutability.

#### Task 1.4: Lock the Generated NodeNext Contract Depends on [1.3]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-generated-client/generator-spike.md`
- `packages/rfmedia-cli/src/lib/lidarr/generated/`
- `packages/rfmedia-cli/tsconfig.json`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

Files to Modify

- None.

Import the four exact generated operations and representative wire types through NodeNext `.js`
specifiers. Instantiate two generated clients with distinct base URLs and Fetch implementations,
exercise real named operations, and assert URL/method/query shape, result envelopes, custom Fetch,
runtime ESM import, and instance isolation. This test is the executable coupling to generator-derived
names because the upstream schema has no `operationId` values. Run it and package typecheck on Node
22 before proceeding.

#### Task 1.5: Add the Explicit Immutable-Ref Refresh Workflow Depends on [1.2, 1.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `docs/plans/lidarr-generated-client/research-security.md`
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`

**Instructions**

Files to Create

- `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.mjs`
- `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.test.mjs`

Files to Modify

- None.

Make this the only networked workflow. Accept only a full immutable commit, use the allowlisted
repository/path/host, reject redirects, cap time and bytes, validate JSON/OpenAPI/local refs/required
operations/security, recompute provenance, and stage snapshot, manifest, and generated output
atomically. Schema, environment, and CLI data must not select paths, plugins, packages, commands, or
hosts. Test with mocked Fetch/local fixtures for mutable refs, redirects, stalls, oversize, invalid
JSON, remote refs, missing contracts, provenance failure, and last-known-good preservation.

### Phase 2: Preserve Security and Application Boundaries

#### Task 2.1: Extract the Hardened Fetch Transport Depends on [1.3, 1.4]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/lib/lidarr/errors.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/lidarr/transport.ts`
- `packages/rfmedia-cli/src/lib/lidarr/transport.test.ts`

Files to Modify

- None.

Move the current trust/resource behavior into one generated-client-compatible Fetch closure. Validate
the final Request before key retrieval: HTTP(S), exact canonical origin, no embedded credentials or
fragment, no credential-like query, and no pre-existing auth/key headers. Then obtain the origin-bound
key, inject exactly one `X-Api-Key`, force `redirect: "error"`, compose caller abort and timeout, and
keep both active through body consumption. Stream-cap success at 8 MiB and error content at 4 KiB,
cancel on overflow, fatal-decode UTF-8, and return only a bounded reconstructed Response. Sanitize all
failures and preserve caller abort identity, status, retryability, and valid `Retry-After` metadata.

`SEC-194-01` is a hard stop: test exact-origin/header-only confinement, redirect rejection, late key
access, and interleaved concurrent two-client origin/key isolation. `SEC-194-02` is a hard stop: test
chunked/missing/invalid/understated lengths, oversized success/error streams, stalls, timeout,
caller abort, invalid UTF-8, reader cancellation, and cleanup. Do not proceed if either control fails.

#### Task 2.2: Preserve Strict Domain Projections Depends on [1.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/types/lidarr.ts`

Keep canonical frozen connection data, the private `WeakMap`, origin-bound key lookup, and provider.
Reframe public interfaces as narrow command-facing domain projections and retain focused `unknown`
validation that constructs fresh objects. Reject missing or wrong required fields, non-finite numbers,
invalid health enums, malformed arrays, and nested records. Never alias, trust, import, or publicly
export generated models; remove only generic query types made obsolete by the facade migration.

#### Task 2.3: Migrate the Stable Facade to Four Generated Operations Depends on [1.4, 2.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts`
- `packages/rfmedia-cli/src/lib/lidarr/errors.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`

Create one private generated client per `LidarrClient`, inject the hardened transport, and call the
four named generated operations. Preserve `LidarrClientApi`, method signatures, operation labels,
dependency injection, direct domain returns, wanted defaults (`1`, `50`, `releaseDate`), omission of
unset sort direction, typed errors, retry metadata, and abort behavior. Privately unwrap generated
envelopes, treat data as unknown, apply strict projections, and discard raw generated/fetch/parser
objects. Remove `LidarrRequest`, generic `request<T>()`, manual endpoint paths, verbs, and query
serialization. Focused tests must exercise the actual generated operations through injected Fetch;
also rerun unchanged index, error, and tier suites.

#### Task 2.4: Enforce Generated and Transport Ownership Depends on [1.3, 2.1, 2.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`
- `docs/plans/lidarr-generated-client/analysis-architecture.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`

Preserve every Plex rule while moving the sole handwritten Lidarr Fetch owner to `transport.ts`.
Allow generated-internal plumbing precisely, but require `client.ts` to be the only non-generated
production importer of the generated tree; reject generated-symbol re-exports from the facade or any
public barrel, and reject handwritten Lidarr API path literals outside generated code/test fixtures.
Add independent failure fixtures for unauthorized imports/re-exports, zero or multiple transport
Fetch sites, upper-layer Fetch, and handwritten paths; retain a real-tree check.

### Phase 3: Integrate Tooling, CI, and Maintainer Documentation

#### Task 3.1: Wire Package Scripts, Lockfile, and CI Drift Depends on [1.1, 1.3, 1.4, 1.5, 2.4]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/package.json`
- `.github/workflows/rfmedia-cli.yml`
- `docs/plans/lidarr-generated-client/analysis-integration.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/package.json`
- `package-lock.json`
- `.github/workflows/rfmedia-cli.yml`

Preserve Task 1.1's exact dependency choice. Add offline `codegen:lidarr`,
`codegen:lidarr:check`, script-test, and explicit networked `openapi:lidarr:refresh` commands. Wire
offline drift and architecture tests into appropriate package pre-gates without any install,
prepare, build, or runtime refresh. Add focused codegen-tooling and drift steps after `npm ci` and
before typecheck/tests in the existing read-only Node 22 job; add no credentials, publish workflow,
or live Lidarr dependency. Prove check mode works without network and reports drift without repairing
it.

#### Task 3.2: Document the Decision, Workflow, Attribution, and Package Contents Depends on [1.5, 2.3, 3.1]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-generated-client/analysis-docs.md`
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/package.json`
- `.github/pull_request_template.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/THIRD_PARTY_NOTICES.md`

Files to Modify

- `packages/rfmedia-cli/README.md`

Record the final TsArr/Hey API evidence, immutable snapshot provenance, ownership boundary, exact
offline write/check/test commands, immutable refresh, review procedure, rollback, failure recovery,
security controls, and no-publish rule. Attribute Lidarr's GPL-3.0-labelled source document and the
MIT generator/bundled runtime without making an unreviewed legal conclusion. Link the notice from
the README license section. Measure generated/tracked/packed bytes, typecheck duration, and cold help
startup; inspect `npm pack --dry-run --workspace packages/rfmedia-cli` for snapshot, notice,
generated code, maps, sources, tests, plans, and secrets. Record the metric baselines and the reviewed
pack allow/deny evidence in `docs/features/lidarr-generated-client.md`. Publication remains out of
scope pending maintainer approval.

#### Task 3.3: Prove Upper-Layer and Completion Compatibility Depends on [2.3, 3.1, 3.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- `ROADMAP.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/CHANGELOG.md`

Run all unchanged Lidarr action, command, tier, error, connection, and Bash/Zsh/Fish completion
contracts. Confirm completion templates remain byte-for-byte unchanged because no command, flag, or
enum changed, using an explicit merge-base diff against `origin/master` for all three template files.
Add an Unreleased changelog entry describing the internal generated-client and offline maintenance
workflow without claiming a release or user-facing command change. Defer the final `ROADMAP.md`
shipped/PR-link edit until the pull-request number exists.

### Phase 4: Validate and Deliver

#### Task 4.1: Run the Complete Offline Validation and Update Graphify Depends on [1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-generated-client/feature-spec.md`
- `docs/plans/lidarr-generated-client/parallel-plan.md`
- `package.json`
- `packages/rfmedia-cli/package.json`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Run `npm ci`, offline drift, generator/refresh tooling tests, architecture tests/checks, focused
transport and facade tests, all Lidarr upper-layer/completion suites,
`npm run typecheck --workspace packages/rfmedia-cli`,
`npm run test:coverage --workspace packages/rfmedia-cli`, `npm run build:rfmedia`,
`npm run format:check`, `npm run lint:md`, `git diff --check`, and
`npm pack --dry-run --workspace packages/rfmedia-cli` on Node 22. Run `graphify update .` as a local
validation action; because `graphify-out/` is ignored and absent in this worktree, do not copy or
modify the user's main checkout graph and do not stage ignored graph output. Audit the complete diff
for secrets, mutable upstream inputs, ranges, generated hand-edits, completion drift, unrelated
changes, and both critical security controls. This validation task may repair files owned by earlier
tasks only when a concrete finding requires a scoped fix; rerun affected and full gates. No green
typecheck may substitute for `SEC-194-01` or `SEC-194-02`.

#### Task 4.2: Open the PR, Finalize ROADMAP, Review, Merge, and Clean Up Depends on [4.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `ROADMAP.md`
- `docs/plans/lidarr-generated-client/analysis-docs.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`

Commit intentionally, push the issue branch to GitHub, and open a draft PR from the repository
template against explicit base `master`, using a Conventional Commit title such as
`feat(rfmedia): generate Lidarr API client` with no Draft/WIP prefix. Include `Closes #194`, exact
test outcomes, high-risk transport/supply-chain notes, no-publish scope, and atomic revert guidance.
Once the PR number exists, update every relevant ROADMAP location to mark only #194 shipped and link
that PR; leave #195, #196, and all later Lidarr work open, then commit and push the update. Perform
formal code review, fix every actionable finding, rerun affected and full validation, and resolve
review threads. Mark the PR ready with `gh pr ready`, then revalidate title, base, body, unresolved
threads, and required checks. Wait for all required CI to pass and squash-merge only after green CI
and zero unresolved actionable findings. Verify issue #194 closed, fetch/prune, remove only the
dedicated worktree and local feature branch, and leave the user's dirty main checkout untouched.
This root-agent-only task is strictly serial and must not be delegated because it mutates GitHub and
performs final branch/worktree cleanup.

## Advice

- Treat generated output as one replace-only artifact: repair inputs/config/scripts and regenerate;
  never patch individual generated files.
- The bundled Fetch runtime reduces runtime dependency surface but does not supply policy; all final
  Request validation, credentials, redirect handling, streaming bounds, and strict decoding remain
  handwritten in `transport.ts`.
- Validate the final generated Request before retrieving the key. Validating only facade inputs
  cannot detect generated base-URL, query-auth, or header changes.
- Keep the timeout active until the response body is fully bounded and reconstructed; stopping it at
  headers would leave the generated parser exposed to stalled or unbounded streams.
- The upstream schema lacks `operationId`, so the generated-contract test is the deliberate coupling
  to derived names and must fail visibly on generator/spec refresh.
- Ordinary install/build/test/CI must remain network-free with respect to GitHub and Lidarr. Only the
  explicit immutable-ref refresh command may contact upstream.
- Do not touch Bash, Zsh, or Fish templates unless the command surface actually changes; unchanged
  parity tests are affirmative acceptance evidence.
- Package publication is not authorized by #194. Preserve attribution, inspect the tarball, and leave
  any legal/package-files policy decision for explicit maintainer approval.
