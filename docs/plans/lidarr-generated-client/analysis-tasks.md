# Task Structure Analysis: Lidarr Generated Client

## Executive Summary

Implement issue #194 as twelve file-bounded implementation tasks followed by two delivery gates.
The critical path proves the generator/runtime pair first, freezes the official Lidarr snapshot and
provenance contract, generates a private SDK, places the existing security policy beneath that SDK,
and only then migrates the stable four-method facade. Architecture, CI, documentation, packaging,
and roadmap work follow the runtime boundary rather than racing it.

The critical path is:

```text
T01 generator spike and exact pins
  -> T02 snapshot/provenance/config
  -> T03 deterministic generation and committed SDK
  -> T04 generated NodeNext contract
  -> T06 hardened transport (SEC-194-01 and SEC-194-02)
  -> T08 facade migration and domain projection
  -> T09 architecture enforcement
  -> T10 CI/package integration
  -> T11 maintenance, attribution, and pack evidence
  -> T12 ROADMAP and compatibility evidence
  -> G01 full validation and Graphify update
  -> G02 PR, review/fix, CI, squash merge, and cleanup
```

Two supporting paths may run in parallel after their inputs stabilize:

- `T02 -> T05` implements the explicit immutable-ref upstream refresh independently of runtime
  migration.
- `T03 -> T07` aligns the stable domain projection documentation and guards while T06 proves the
  transport.

The complete generated directory counts as one machine-owned artifact set even though it contains
many files. No task may manually edit individual generated files. Bash, Zsh, and Fish completion
sources are explicit non-touch files because no command, option, or enum changes; the existing
cross-shell test is the acceptance evidence.

## Recommended Phase Structure

### Phase 1 — Prove and freeze the toolchain

T01 must finish before persistent codegen design is coupled to an assumed generator API. T02 then
freezes the immutable input and configuration. T03 produces both the atomic offline workflow and the
first committed generated tree; T04 proves the exact exported names and Node 22 runtime shape.

| Task | Purpose                                                               | Logical files | Depends on |
| ---- | --------------------------------------------------------------------- | ------------: | ---------- |
| T01  | Hey API spike, fallback decision, exact dependency pins, decision log |             3 | —          |
| T02  | Official snapshot, deterministic manifest, generator configuration    |             3 | T01        |
| T03  | Atomic write/check workflow and complete generated SDK                |             3 | T02        |
| T04  | NodeNext/runtime/generated-operation contract                         |             1 | T03        |
| T05  | Immutable-ref upstream refresh and fixture tests                      |             2 | T02, T03   |

Phase exit: Node 22 can import and invoke the exact generated client through an injected Fetch;
the full SDK regenerates byte-for-byte from checked-in inputs; check mode detects every changed,
missing, extra, or symlink entry without changing the worktree; refresh is the only networked path.

### Phase 2 — Preserve the trust and application boundaries

T06 is a hard merge stop and must use the real generated Fetch call shape proven by T04. T07 may run
alongside T06 because it owns only domain/guard definitions. T08 composes generated operations,
transport, projectors, defaults, and the stable error taxonomy. T09 then makes those ownership rules
executable.

| Task | Purpose                                                         | Files | Depends on    |
| ---- | --------------------------------------------------------------- | ----: | ------------- |
| T06  | Instance-scoped secure Fetch transport and adversarial tests    |     2 | T03, T04      |
| T07  | Stable public domain projections and strict runtime guards      |     2 | T03           |
| T08  | Four-operation facade migration and compatibility tests         |     2 | T04, T06, T07 |
| T09  | Sole-Fetch-owner and private-generated-import architecture gate |     2 | T03, T06, T08 |

Phase exit: both CRITICAL controls `SEC-194-01` and `SEC-194-02` pass; no handwritten production
module owns a Lidarr endpoint path, HTTP verb, or generic query serializer; generated types and
result envelopes do not cross `LidarrClientApi`; existing command/error/tier behavior remains
unchanged. The roadmap must mark only issue #194 as shipped; later Lidarr issues remain open.

### Phase 3 — Operational integration and durable evidence

T10 wires offline drift into the package and Node 22 CI after all codegen scripts are stable. T11
records maintainer workflows, the TsArr decision, attribution, measurements, and packed-content
evidence. T12 runs unchanged upper-layer/completion contracts and updates only #194 in the roadmap.

| Task | Purpose                                                          | Files | Depends on         |
| ---- | ---------------------------------------------------------------- | ----: | ------------------ |
| T10  | Package scripts, lockfile, explicit CI drift gate                |     3 | T01, T03, T04, T09 |
| T11  | Regeneration/refresh/rollback docs, attribution, pack inspection |     3 | T05, T08, T10      |
| T12  | Completion parity evidence and ROADMAP #194 completion           |     1 | T08, T10, T11      |

Phase exit: ordinary install, generation, typecheck, build, test, and PR CI do not contact GitHub or
a live Lidarr; the package has exact tool pins, attribution, and reviewed tarball contents; only
The roadmap marks no other Lidarr issue shipped.

### Phase 4 — Validation and delivery gates

These gates have no planned source-file edits. Any defect found here becomes a narrowly scoped fix
task tied to the finding, followed by the affected focused tests and a rerun of the gate.

| Gate | Purpose                                                                                                            | Planned files | Depends on |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------------: | ---------- |
| G01  | Offline drift, architecture, Node 22-compatible typecheck/tests/build/pack, docs lint, Graphify update, diff audit |             0 | T01-T12    |
| G02  | Template PR, formal review and fixes, green CI, squash merge, issue closure, branch/worktree cleanup               |             0 | G01        |

## Task Granularity and Dependency Analysis

### T01 — Prove the generator/runtime pair and pin it exactly

**Files (3):**

- `docs/plans/lidarr-generated-client/generator-spike.md` (create)
- `packages/rfmedia-cli/package.json`
- `package-lock.json`

**Actions:** run the candidate `@hey-api/openapi-ts@0.93.0` under the repository's supported Node
22 line against the pinned Lidarr document. Record the emitted Fetch client package/version, ESM
import shape, `.js` NodeNext specifiers, named operation exports, result/error envelope, redirect
behavior, injected-Fetch API, per-instance isolation, and mocked request result. Record the already
observed TsArr facts: `tsarr@2.12.0` declares Node `>=24.16.0`, its Node 22 smoke request succeeds
outside its supported engine contract, and its module-global client fails two-client isolation.
Choose Hey API only if it preserves instance-scoped custom Fetch and bounded-response interception;
otherwise record the failure and switch this task to exact `openapi-typescript` plus
`openapi-fetch` pins before later tasks begin. Add exact dev-dependency pins only; do not add TsArr,
Bun, ranges, install hooks, or a runtime-floor increase.

**Validate:** run `npm install --package-lock-only` only as needed after the actual exact pin is
known, `npm ci`, a Node 22 import/request probe, and
`npm run typecheck --workspace packages/rfmedia-cli`. Inspect the lockfile for the chosen generator
and runtime versions and for the absence of TsArr/Bun.

### T02 — Add the immutable snapshot, manifest, and generator configuration

**Files (3):**

- `packages/rfmedia-cli/openapi/lidarr-v1.json` (create)
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json` (create)
- `packages/rfmedia-cli/openapi-ts.config.mjs` (create; rename if T01 selects the documented fallback)

**Actions:** commit the exact official file from `Lidarr/Lidarr` commit
`3e2858439ff35b372d0af00bcea1b0a357572d26`, preserving source bytes. Define a versioned,
timestamp-free manifest with repository, full commit, exact path, commit-pinned raw URL, Git blob
SHA, exact-byte SHA-256, OpenAPI version, generator/config version, and exact generator/runtime pins.
Configure one full private Fetch SDK at `src/lib/lidarr/generated/`, using the package tsconfig,
NodeNext-compatible `.js` imports, stable formatting, and no network plugins or mutable input URLs.
Validate all `$ref` targets are local and assert the four required operations plus both documented
security schemes before generation.

**Validate:** independently recompute SHA-256 and Git blob SHA; parse the JSON; confirm OpenAPI
`3.0.4`, the four operation paths, and no remote `$ref`; run the generator's config-load/dry probe
from both the repository root and package directory.

### T03 — Implement atomic offline generation and drift detection

**Files (3 logical artifacts):**

- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` (create)
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs` (create)
- `packages/rfmedia-cli/src/lib/lidarr/generated/` (create, complete generated artifact set)

**Actions:** support explicit write and check modes from package-relative checked-in inputs. Both
modes generate into a fresh temporary directory, validate required output and generated headers,
and enumerate sorted relative entries without following symlinks. Write mode must verify the
resolved destination is exactly the expected directory and replace it only after successful
generation/validation, preserving the last known-good tree on any failure. Check mode compares
entry names, entry types, and file bytes and reports changed, missing, extra, symlink, and non-file
entries plus the exact repair command without mutating the tree. The checked-in full SDK is
replace-only and receives no handwritten edits.

**Validate:** Node fixture tests cover byte-identical repeat generation, changed/missing/extra files,
snapshot/config/manifest mismatch, symlinks and non-file entries, path confinement, failed-generation
preservation, sorted diagnostics, and unchanged `git status --short` around check mode. Run write,
then check twice from different current working directories.

### T04 — Lock the generated NodeNext and instance contract

**Files (1):**

- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts` (create)

**Actions:** import the four exact generated operations and representative generated wire types
using `.js` specifiers. Construct two generated clients with distinct base URLs and injected Fetch
functions, invoke at least one real named operation for each, and assert isolation, final operation
URL/method/query, result-envelope shape, and runtime ESM import under Node 22. This is a contract on
the generated output, not a mock of generated functions.

**Validate:**
`npm exec -w packages/rfmedia-cli vitest -- run src/lib/lidarr/generated-contract.test.ts` and
package typecheck under Node 22.

### T05 — Add explicit immutable-ref upstream refresh

**Files (2):**

- `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.mjs` (create)
- `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.test.mjs` (create)

**Actions:** accept only a full commit SHA, build only the allowlisted `Lidarr/Lidarr` raw URL/path,
cap download size and duration, require successful JSON/OpenAPI parsing, reject non-local `$ref`
values, verify the four required operations/security schemes, and recompute both provenance hashes.
Stage snapshot and manifest together, invoke normal generation, and publish the new set only after
all validation passes. The refresh command is the only workflow allowed to access upstream; it must
not allow document/config/environment values to choose paths, packages, plugins, commands, or hosts.

**Validate:** local fixture/server tests cover invalid/mutable refs, wrong host/path, redirects,
oversized/stalled/invalid JSON, remote refs, missing operations/security, hash mismatch, and atomic
preservation on failure. A successful fixture refresh must leave normal generation/check fully
offline and clean.

### T06 — Extract and prove the hardened generated-client Fetch transport

**Files (2):**

- `packages/rfmedia-cli/src/lib/lidarr/transport.ts` (create)
- `packages/rfmedia-cli/src/lib/lidarr/transport.test.ts` (create)

**Actions:** move the existing application trust/resource policy into one Fetch-compatible closure.
Resolve `Request` and `RequestInit` exactly as the generated runtime does; reject non-HTTP(S), embedded
credentials, any final origin other than the configured origin, credential-like query keys/values,
and pre-existing `X-Api-Key` or `Authorization` before retrieving the key or calling Fetch. Obtain the
origin-bound key at the final safe moment, inject exactly one header, force `redirect: "error"`, and
retain caller abort plus timeout through body consumption. Stream at most 8 MiB for success and 4 KiB
for errors regardless of `Content-Length`, cancel on overflow, fatal-decode UTF-8, and return only a
bounded reconstructed `Response` to generated parsing. Preserve status/Retry-After handling and
sanitized network/timeout/cancellation semantics without exposing raw bodies or keys.

**Critical merge stops:** `SEC-194-01` requires exact-origin/header-only credential confinement,
redirect rejection, and concurrent/interleaved two-client key/origin isolation. `SEC-194-02`
requires generated parsing to receive only bounded bodies and covers chunked, missing/invalid/
understated length, oversized success/error, stalled consumption, caller abort, timeout, invalid
UTF-8, reader cancellation, and cleanup. Neither control may be deferred or downgraded.

**Validate:**
`npm exec -w packages/rfmedia-cli vitest -- run src/lib/lidarr/transport.test.ts`; run with fake
timers where deterministic and real `ReadableStream` fixtures for body/abort behavior. Inspect
serialized clients/errors and captured logs/URLs/headers to prove key and raw-body absence.

### T07 — Preserve strict domain projections

**Files (2):**

- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/types/lidarr.ts`

**Actions:** retain canonical frozen connection settings, the private `WeakMap` key binding,
`getLidarrConnectionApiKey`, and `StaticLidarrApiKeyProvider`. Reframe the public Lidarr interfaces
as stable command-facing domain projections, never aliases or exports of broad generated models.
Retain or convert the current `unknown` guards into focused projectors that construct fresh objects
and reject missing/wrong required fields, non-finite numbers, invalid health enums, malformed arrays,
and nested-record errors. Do not trust generated TypeScript types as runtime validation.

**Validate:** package typecheck plus the malformed projection matrix in `client.test.ts`; review
public barrels to confirm no generated type or module is exported.

### T08 — Migrate the stable facade to four named generated operations

**Files (2):**

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`

**Actions:** preserve `LidarrClientApi`, `LidarrWantedQuery`, method signatures, operation labels,
injected dependency seam, return types, typed errors, and action-facing behavior. Construct one
private generated client per `LidarrClient` using T06's transport. Replace the four handwritten
endpoint implementations with named generated operations. Preserve wanted defaults
`page=1`, `pageSize=50`, `sortKey=releaseDate`, omit unset `sortDirection`, and do not begin sending
other generated parameters. Unwrap generated data/error envelopes privately, feed values through
T07 projectors, translate errors once into the existing `LidarrError` taxonomy, and remove public
`LidarrRequest`, generic `request<T>()`, path literals, verbs, and generic query serialization.

**Validate:** focused tests exercise the actual generated operations through injected Fetch and
prove all four URLs, methods, wanted query omission/defaults, stable returns, malformed bodies,
HTTP classification, Retry-After, timeout/caller abort, sanitized failures, and concurrent clients.
Then run unchanged `index.test.ts`, `errors.test.ts`, and `tiers.test.ts`.

### T09 — Enforce generated and transport ownership in architecture checks

**Files (2):**

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`

**Actions:** generalize diagnostics/naming if useful while preserving every Plex rule. Move the sole
Lidarr Fetch owner from `client.ts` to `transport.ts`, require exactly one production Fetch site
there, reject any other Lidarr/upper-layer Fetch, and allow generated internal Fetch plumbing only
through a precise machine-owned exception if the emitted runtime necessarily contains it. Enforce
that only the Lidarr facade/transport boundary imports `src/lib/lidarr/generated/`; actions,
commands, public type barrels, and unrelated helpers must not. Add a rule rejecting handwritten
Lidarr API path literals outside the generated tree/test fixtures so endpoint ownership cannot drift
back into the facade.

**Validate:** Node fixtures prove each new rule fails independently, legitimate generated/facade/
transport imports pass, old Plex fixtures remain green, and the real production tree passes
`npm run test:architecture --workspace packages/rfmedia-cli` and `npm run check:architecture
--workspace packages/rfmedia-cli`.

### T10 — Wire package scripts, exact pins, and explicit CI drift

**Files (3):**

- `packages/rfmedia-cli/package.json`
- `package-lock.json`
- `.github/workflows/rfmedia-cli.yml`

**Conflict note:** T01 is the only earlier task touching package/lock files. T10 must be serialized
after it and preserve its exact dependency decision rather than reinstalling newer versions.

**Actions:** add `codegen:lidarr`, `codegen:lidarr:check`, and
`openapi:lidarr:refresh` package scripts; normal generation/check use checked-in inputs only. Include
offline drift and script tests in the package's architecture/pretypecheck path without making
ordinary install/build contact upstream. Add a named drift step in the Node 22 rfmedia CI job before
typecheck/tests so failures are distinguishable. Keep refresh manual and outside PR CI; do not add
publish automation or credentials.

**Validate:** `npm ci`; run write/check, architecture tests, and typecheck via their package scripts;
verify check mode succeeds with networking unavailable and fails after a temporary generated edit
without rewriting it. Parse the workflow and confirm the drift gate runs on the existing Node 22 job.

### T11 — Document maintenance, attribution, rollback, and package contents

**Files (3):**

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` (create)
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/openapi/NOTICE.md` (create)

**Actions:** document the TsArr/Hey API decision and exact evidence, architecture/ownership diagram,
offline regenerate/check commands, immutable-ref refresh, generated-file review, version-upgrade
procedure, rollback, failure recovery, and security invariants. Attribute the official
GPL-3.0-labelled Lidarr source document with repository/path/commit/license and distinguish upstream
snapshot licensing from the repository's MIT handwritten code. Record generated/tracked/packed size,
typecheck duration, and cold `rfmedia --help` startup; keep the full SDK unless measured material
regression justifies a separately reviewed deterministic filter. Run `npm pack --dry-run` and record
whether snapshot, notice, generated source, source maps, tests, and planning artifacts are included.
This issue performs no `npm publish`; any future publication remains blocked on explicit maintainer
approval of license/content treatment.

**Validate:** exact documented commands work from a clean checkout; `npm pack --dry-run -w
packages/rfmedia-cli` output is reviewed for secrets, snapshot/provenance/notice consistency, and
unexpected generated or test noise; Markdown lint and link checks pass.

### T12 — Prove unchanged CLI/completion behavior and close the roadmap item

**Files (1):**

- `ROADMAP.md`

**Explicit non-touch files:**

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

**Actions:** run the existing action and command suites without changing their generated-client-free
mocks or public surface. Run the cross-shell template assertions and confirm Bash, Zsh, and Fish
still expose exactly `status`, `list`, `wanted`, and `health` with the same flags. Mark only #194
shipped in the sprint and Lidarr sections, link the implementation PR once its number exists, and
describe local generated OpenAPI as replacing the temporary handwritten client. Do not imply that
issues `#195` or `#196`, later discovery/mutation work, or a publication decision shipped.

**Validate:** run all `src/actions/lidarr/*.test.ts`, `src/commands/lidarr.test.ts`, and
`src/lib/shell-completions/templates.spec.ts`; inspect `git diff` to prove all three completion source
files are byte-for-byte unchanged.

## Parallel Opportunities and File-Conflict Rules

- T01 and T10 both own `packages/rfmedia-cli/package.json` and `package-lock.json`; they must be
  serialized. No other task may touch dependency metadata.
- T03 owns the entire generated tree. T04, T06, T08, and T09 may read/import it but must never edit
  it. Any generated correction is made in snapshot/config/script inputs and rerun through T03.
- T05 can run in parallel with T04 after T03. It owns refresh files only and must call, not copy,
  the generation workflow.
- T06 and T07 can run concurrently after T03/T04 because their file sets do not overlap. T08 waits
  for both.
- T09 waits for the real import/fetch shape in T08; otherwise its allowlist would be speculative.
- T11 waits for T10 and pack inspection; T12 waits for the final command surface and docs wording.
- Existing action, command, tier, error, index, and completion tests are validation consumers, not
  implementation ownership. Change one only if a demonstrated compatibility defect requires a new
  scoped fix task.
- New files in different tasks do not conflict. The only new-directory ownership is T03's generated
  tree; all other created files have unique paths.

## Critical Merge Stops and Final Validation

`SEC-194-01` and `SEC-194-02` are non-negotiable phase-2 exits. A green typecheck or generated SDK
smoke test cannot substitute for their adversarial runtime coverage. G01 must also verify that no
test bypasses the actual generated operation/transport path for those controls.

Run G01 from the dedicated issue worktree, at minimum:

```bash
npm ci
npm run codegen:lidarr:check --workspace packages/rfmedia-cli
npm run test:architecture --workspace packages/rfmedia-cli
npm run typecheck --workspace packages/rfmedia-cli
npm run test:coverage --workspace packages/rfmedia-cli
npm run build:rfmedia
npm run format:check
npm run lint:md
npm pack --dry-run --workspace packages/rfmedia-cli
graphify update .
git diff --check
```

After `graphify update .`, review and commit only graph changes attributable to the implementation.
Audit the final diff for secrets, mutable upstream URLs, unpinned dependencies, manual generated-file
edits, completion drift, and unrelated worktree changes. G02 then uses the repository PR template,
includes `Closes #194` and exact pass/fail commands, performs formal review and finding fixes, waits
for all required CI to pass, squash-merges, verifies issue closure, and removes only the dedicated
branch/worktree after the merge is confirmed.
