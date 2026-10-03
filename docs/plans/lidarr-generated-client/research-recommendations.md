## Executive Summary

Implement issue #194 with a locally generated, committed Lidarr SDK rather than a runtime dependency
on TsArr. The TsArr spike is decisive: `tsarr@2.12.0` declares Node `>=24.16.0` while rfmedia-cli
supports Node `>=22.0.0`, and its module-scoped client configuration allowed a later client to replace
an earlier client's origin and API key. A mocked request succeeding on Node 22 does not override the
published engine contract or the demonstrated isolation failure.

Use the official Lidarr v1 OpenAPI document pinned to immutable upstream commit
`3e2858439ff35b372d0af00bcea1b0a357572d26` as the initial candidate snapshot, subject to confirming
that it matches the supported/deployed Lidarr release. Generate the complete private SDK with exact
`@hey-api/openapi-ts@0.93.0`, ESM/NodeNext output, `.js` import specifiers, and the Fetch client. Pin
the emitted `@hey-api/client-fetch` runtime version exactly after a generation spike confirms the
pairing; do not use a range or an unversioned `npx` invocation. Commit the snapshot, manifest, config,
and generated output so normal builds, tests, and runtime remain offline.

Keep `LidarrClientApi` and its four direct-body methods as the application boundary. Generated code
owns endpoint paths, HTTP verbs, query serialization, and full wire DTOs. A small handwritten
`transport.ts` owns trust policy, and `client.ts` selects four generated operations, applies existing
defaults, validates untrusted results, projects them into stable domain types, and maps failures into
the existing `LidarrError` taxonomy. Remove the generic handwritten `request()`/`LidarrRequest`
escape hatch; it would preserve the exact maintenance path this issue is meant to eliminate.

Two security requirements are CRITICAL merge stops:

1. Credentials may exist only in the origin-bound provider and the final secure fetch closure. The
   generated client must never store the API key in configuration, headers, auth state, options, or a
   result envelope. The final transport validates the generated URL, rejects auth-like query/header
   input, retrieves the key, injects only `X-Api-Key`, and forces `redirect: "error"`.
2. Generated code may never parse an unbounded body. The transport must keep timeout/cancellation
   active while it caps and strictly decodes both success and error streams, then return a bounded
   reconstructed `Response` or a fixed typed failure before generated code calls `json()`/`text()`.

This is an internal transport change. Do not change commands, flags, output envelopes, action mocks,
or Bash/Zsh/Fish completion templates. Run the existing cross-shell parity tests unchanged. Update
`ROADMAP.md` only when the generated client, deterministic drift gate, documentation, contracts, and
CI evidence are complete; do not imply that #195, #196, or later mutation/discovery issues shipped.

## Implementation Recommendations

### 1. Freeze the decision and compatibility contract

- Commit a short TsArr decision record capturing tested versions, declared engines, ESM import and
  mocked-call results, injected-fetch behavior, result envelope, redirect behavior, and the
  two-instance origin/key isolation failure.
- Adopt local generation without raising rfmedia-cli's Node floor solely for this issue.
- Use exact `@hey-api/openapi-ts@0.93.0` as the initial generator because its Node `>=20.19.0`
  declaration covers the package's Node 22 floor and it can emit strict NodeNext Fetch output.
- Confirm the exact generated runtime dependency in the spike, pin it without a range in
  `package.json`/`package-lock.json`, and record generator plus runtime-client versions in the
  manifest. The inspected `@hey-api/client-fetch@0.13.1` behavior must be treated as unsafe by
  default even if the final paired version differs.
- Generate the full private v1 SDK initially. Keep the complete upstream snapshot untouched; do not
  create a hand-edited four-path spec. Measure tracked/packed bytes, typecheck time, and cold CLI
  startup before considering a declarative filter.

### 2. Establish immutable provenance and deterministic code generation

- Add `packages/rfmedia-cli/openapi/lidarr-v1.json` and
  `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`. The manifest should contain a schema
  version, `Lidarr/Lidarr`, full commit SHA, exact source path and commit-pinned URL, upstream Git
  blob SHA, exact-byte SHA-256, exact generator/runtime versions, and config version. Exclude
  timestamps, machine paths, hosts, and usernames.
- Add one `openapi-ts.config.mjs` job producing Fetch SDK/types into
  `src/lib/lidarr/generated/`, with NodeNext-compatible `.js` imports and a machine-owned header.
  Generated files are replace-only and private; never edit or export them manually.
- Add `codegen:lidarr` and `codegen:lidarr:check`. Write mode generates and validates in a fresh
  temporary directory before atomically replacing exactly the expected generated directory. Check
  mode never changes the checkout and recursively compares sorted file names, entry types, and
  bytes, including missing, modified, extra, and symlink entries.
- Validate the manifest and snapshot before generator execution. Generation must assert that the
  four required operations/models exist and must run entirely from local inputs.
- Add a distinct `openapi:lidarr:refresh -- --ref <immutable-ref>` workflow. It may resolve a tag or
  commit through the allowlisted `Lidarr/Lidarr` repository, but it must download the exact path from
  the resolved commit, cap input size, verify JSON/OpenAPI structure, reject non-local `$ref` values,
  verify required operations/security schemes, update provenance/digest, regenerate, and leave the
  full diff for review. It must never run in install, build, typecheck, or ordinary PR CI.
- Constrain destructive script paths: resolve the package root and fixed output child, reject
  symlinks, reject any path from spec/config/environment/CLI input, and replace output only after all
  checks succeed.

### 3. Preserve security through an injected transport

- Extract the current request-policy machinery into
  `src/lib/lidarr/transport.ts` as one small generated-client-compatible Fetch factory. Keep native
  Node 22 `fetch`, `URL`, `AbortController`, `TextDecoder`, `Request`, and `Response`; do not add a
  general HTTP or middleware framework.
- Accept both `Request` and URL/string inputs as required by the generated Fetch runtime, then inspect
  the final generated request. Require HTTP(S), exact canonical origin equality, no embedded
  credentials or fragment, and no authentication-like query key/value.
- Reject pre-existing `X-Api-Key`, `Authorization`, cookie, proxy-auth, or token headers. Retrieve the
  API key from the existing private origin-bound provider only after URL validation, then reconstruct
  the outgoing request with `Accept: application/json`, exactly one `X-Api-Key`, the composed signal,
  and `redirect: "error"`.
- Preserve the current 8 MiB success and 4 KiB error caps. Count decoded bytes actually streamed,
  rather than trusting `Content-Length`; cancel on overflow. Keep timeout and caller cancellation
  active through body consumption, use fatal UTF-8 decoding, discard untrusted error text, and return
  only a bounded reconstructed response or fixed internal sentinel.
- Never expose or attach generated `{ data, error, request, response }` envelopes, raw bodies,
  credential-bearing requests, generated options, or unsanitized network/parser exceptions. Map
  safe status and validated `Retry-After` metadata only; preserve caller abort reason identity.
- Construct a private generated client per `LidarrClient` and pass it explicitly to generated
  operations. Never import/configure a generated singleton.

### 4. Migrate the facade without changing application behavior

- Retain `LidarrClientApi`, `LidarrWantedQuery`, `LidarrClientDependencies`, configuration resolution,
  error classes, action mocks, and command-facing types source-compatibly.
- Have each facade method call one named generated operation. The handwritten facade may own stable
  operation labels and domain defaults, but no endpoint path, HTTP verb, generic query serializer,
  or duplicated wire schema.
- Preserve wanted defaults exactly: `page=1`, `pageSize=50`, `sortKey=releaseDate`, and omit an unset
  `sortDirection`. Do not begin sending `includeArtist`, `monitored`, or other generated options
  unless separately approved as a behavior change.
- Treat generated response data as `unknown`. Retain focused guards/projectors for status, health,
  artists, and wanted records, including nested records, finite numbers, required strings/booleans,
  known health enums, and array shape. Construct fresh domain objects rather than returning
  generated objects by reference.
- Remove public `LidarrClient.request()` and `LidarrRequest`. Keep generated types private to
  `src/lib/lidarr`; actions and commands import only `LidarrClientApi` and stable domain projections.
- Extend the existing architecture scanner rather than adding a new lint framework: authorize the
  sole authenticated Lidarr fetch site in `transport.ts`, reject all other fetch owners, and allow
  generated imports only from `client.ts`.

### 5. Make tests and CI prove the boundary

- Split existing request-policy tests into `transport.test.ts`; keep operation/default/projection and
  error-translation tests in `client.test.ts`. Reuse current index, error, tier, action, command, and
  completion tests unchanged wherever possible.
- Add generator-script tests for manifest/digest rejection, path confinement, deterministic repeated
  output, unchanged check mode, required operations, and changed/missing/extra/symlink detection.
- Add a generated contract test proving NodeNext import, per-instance construction, and availability
  of the four required operations and representative models.
- Add the two CRITICAL regression groups before accepting the migration:
  - credential/origin tests: exact header-only auth, no query auth, unsafe header/query rejection,
    redirect rejection, no reflected secret state, and interleaved clients with distinct origins and
    keys;
  - bounded-parser tests: oversized chunked success and error bodies, false/missing
    `Content-Length`, compressed expansion, stalled response reads, timeout during headers/body, abort
    during body consumption, strict UTF-8, and malformed JSON.
- Preserve HTTP/error contracts for 401/403, 404/other 4xx, 429 plus `Retry-After`, 5xx/network,
  timeout, caller cancellation, oversized/malformed response, and configuration/provider failures.
- Run validation in this order for fast feedback: codegen script tests and offline drift check;
  architecture tests; focused transport/client/index/errors/tiers tests; action/command tests;
  unchanged Bash/Zsh/Fish template parity test; typecheck; full coverage; build; `git diff --check`;
  and `npm pack --dry-run` inspection.
- Add an explicit offline codegen-drift step to `.github/workflows/rfmedia-cli.yml` before expensive
  typecheck/tests. Retain `permissions: contents: read`, action SHA pins, and
  `persist-credentials: false`.

### 6. Document, review, and release deliberately

- Document normal generation, read-only drift checking, immutable-ref refresh, provenance fields,
  review procedure, validation commands, rollback, generated-file ownership, and the TsArr decision.
- Separate generated, snapshot/provenance, and handwritten-policy changes in the PR description so
  reviewers can focus on the trust boundary. Include exact commands and pass/fail outcomes.
- Resolve the GPL-3.0-labelled Lidarr specification/publication treatment before publishing the npm
  package. Retain attribution and an approved third-party notice, inspect the packed file list, and
  make an explicit maintainer decision about the snapshot and generated output under current MIT
  package metadata. This is a release gate, not an assumption that generated output changes license.
- Keep shell completion templates byte-for-byte unchanged because no command surface changes. Their
  existing parity test is the required evidence.
- Update `ROADMAP.md` after implementation and validation, marking #194 shipped with the final PR
  link while leaving #195, #196, and later Lidarr work open.

## Improvement Ideas

### Quick wins in this issue

- Rename/generalize the existing architecture check's user-facing output so it reflects Plex and
  Lidarr network/import boundaries instead of reporting every violation as Plex-specific.
- Make codegen success output one concise line containing the pinned commit, generator version, and
  generated file count; on drift, list relative changed/missing/extra files and print the exact repair
  command.
- Verify two consecutive generations are byte-identical during the initial implementation and keep a
  focused deterministic test thereafter.
- Record baseline generated-tree size, packed package size, typecheck duration, and cold
  `rfmedia --help` time so future filtering decisions use evidence.
- Add a package `files` allowlist if rfmedia is publishable, then verify the actual tarball rather than
  relying on `.gitignore` behavior.

### Future follow-ups, outside #194

- Add scheduled/manual upstream drift detection that creates a dedicated, non-auto-merged review PR
  only after licensing, token permissions, and ownership are settled. Do not use
  `pull_request_target` or execute code from an untrusted checkout.
- Add an optional live contract job against a pinned Lidarr container release. It should supplement,
  never replace, deterministic mocked contracts.
- Add deterministic operation filtering only if measured package, compile, startup, or review cost is
  material. Retain the full upstream snapshot and derive transitive schemas automatically with
  fail-closed tests.
- Consider generated runtime validators only when more Lidarr operations make focused projectors
  disproportionate. Body caps and stable error translation remain mandatory even then.
- Consider an HTTPS warning for non-loopback origins. Do not remove private-network HTTP compatibility
  without a separate operator-facing decision.
- Add dependency-review/vulnerability scanning and release SBOM/provenance artifacts for generator or
  runtime-client upgrades.

## Risk Assessment

| Severity     | Risk                                                                                                                                                                   | Required mitigation / acceptance evidence                                                                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CRITICAL** | Generated defaults can store or forward the API key, follow redirects, accept query auth, or let one client overwrite another's origin/credential.                     | API key exists only in the private provider/final transport; exact-origin and unsafe query/header checks occur before retrieval; final request injects only `X-Api-Key` and rejects redirects; interleaved two-client test proves isolation. Merge stop. |
| **CRITICAL** | The generated Fetch runtime eagerly parses success/error bodies without caps, enabling memory exhaustion, timeout bypass during streaming, or decompression expansion. | Transport caps decoded streamed bytes, keeps abort/timeout active through reads, rejects invalid UTF-8, reconstructs only bounded responses, and passes chunked/misleading/compressed/stalled-body tests. Merge stop.                                    |
| **HIGH**     | Generated TypeScript types are mistaken for runtime validation, allowing malformed upstream data into command output or opaque failures.                               | Treat data as `unknown`; retain strict focused projectors for all consumed fields/nested records and map every miss to `invalid-response`.                                                                                                               |
| **HIGH**     | Generated result/error objects leak credential-bearing `Request`, raw `Response`, bodies, headers, or unsafe causes through errors/logs/JSON.                          | Keep generated values private, unwrap immediately, return new domain objects, use fixed safe error messages/status metadata, and add redaction/reflection tests.                                                                                         |
| **HIGH**     | Malicious or compromised OpenAPI input triggers external `$ref` fetches, path writes, plugin changes, or unexpected generated code.                                    | Allowlist repository/path/ref, cap download, reject non-local references, validate operations/security, fix all output paths/plugins, generate in a disposable directory, and require reviewed diffs.                                                    |
| **HIGH**     | Drift verification misses untracked, deleted, type-changed, or symlink files and provides false reproducibility assurance.                                             | Verify complete provenance and exact digest, generate into a fresh directory, recursively compare names/types/bytes, and test every discrepancy class without mutating checkout.                                                                         |
| **HIGH**     | GPL-3.0-labelled upstream spec/generated-output treatment conflicts with MIT package metadata or unintended npm contents.                                              | Obtain explicit maintainer-approved treatment, retain attribution/notice, define packed contents, inspect `npm pack --dry-run`, and do not publish until resolved.                                                                                       |
| **MEDIUM**   | Exact generator/runtime pins expand the npm build and runtime supply chain.                                                                                            | Exact pins plus lock integrity, `npm ci`, local fixed config/plugins, no unversioned `npx`, dependency review, and full security/generated diff review on upgrades.                                                                                      |
| **MEDIUM**   | Generator naming churn from the spec's absent `operationId` values creates large diffs or leaks generated names upward.                                                | Pin generator/config, keep generated code private, compile-contract the four operations, and insulate actions with `LidarrClientApi`.                                                                                                                    |
| **MEDIUM**   | Full generation increases tracked/packed bytes, typecheck memory/time, or cold-start cost.                                                                             | Measure baselines; use direct operation imports and package allowlisting; introduce deterministic filtering only after an agreed budget is exceeded.                                                                                                     |
| **MEDIUM**   | A refresh bot gains enough privilege to turn upstream schema into repository code.                                                                                     | Start with manual refresh; any bot uses minimum permissions, pinned actions, no fork secrets, a dedicated review PR, and no auto-merge or `pull_request_target`.                                                                                         |
| **LOW**      | Upstream `develop` spec differs from an operator's Lidarr version.                                                                                                     | Pin an explicit supported commit/release, keep mocked contracts deterministic, and optionally add a pinned live-container compatibility job later.                                                                                                       |
| **LOW**      | Editing completions despite no CLI surface change causes unnecessary churn.                                                                                            | Leave templates unchanged and run existing Bash/Zsh/Fish parity tests.                                                                                                                                                                                   |

## Alternative Approaches

1. **Use TsArr directly — reject for this issue.** It offers broad generated coverage, but its
   current supported Node floor excludes rfmedia-cli's contract, its public facade is itself
   hand-maintained, its result envelope differs from the stable interface, its default redirects and
   transport do not preserve local policy, and its module-global generated client failed isolation.
   Reconsider only when a current release supports the full Node range, exposes a supported
   instance-scoped client, and passes every transport, body-limit, error, and two-client test.
2. **Use `openapi-typescript` plus `openapi-fetch` — retain as the first fallback.** It has a smaller
   generated type surface and typed path-string calls with injectable Fetch. Choose it if the pinned
   Hey API runtime cannot accept the bounded secure transport or cannot emit valid NodeNext output.
   Its checked path strings are less aligned with the preference for named generated operations, but
   still remove duplicated wire DTOs and unchecked serialization.
3. **Use OpenAPI Generator `typescript-fetch` — viable second fallback.** It is stable and supports
   API-key auth, but adds a Java/tool-download workflow, larger output, and more template/config
   surface. Use only if the two lighter TypeScript-native options fail the hard gates.
4. **Generate types only while keeping the current request wrapper — reject.** This reduces DTO work
   but leaves endpoint paths, verbs, and query serialization handwritten, so it does not satisfy the
   core issue.
5. **Keep the fully handwritten client — reject as the end state.** It is the security baseline and
   rollback option, but continuing it preserves schema/endpoint drift and contradicts #194.
6. **Generate at install/build time or from live `develop` — reject.** It makes installation and CI
   network-dependent, nondeterministic, and vulnerable to upstream changes outside the reviewed diff.

## Task Breakdown Preview

The implementation is dependency-ordered; tasks within a numbered phase may proceed together only
when they do not edit the same files.

1. **Decision and legal/provenance gate**
   - Record the TsArr spike and local-generation choice.
   - Confirm the supported Lidarr revision and package/publication treatment.
   - Exit: immutable upstream ref and attribution decision are documented; generator candidate meets
     Node floor.
2. **Toolchain spike and inputs**
   - Pin `@hey-api/openapi-ts@0.93.0`, determine/pin the exact Fetch runtime, add the complete snapshot,
     manifest, config, and generation scripts.
   - Prove NodeNext typecheck/import, per-instance client construction, required operations, and
     deterministic output.
   - Depends on phase 1.
3. **Secure transport extraction**
   - Move current origin/auth/redirect/abort/timeout/body/delay/redaction behavior to `transport.ts`
     without changing the existing client behavior first.
   - Add both CRITICAL test groups and path-confinement tests.
   - Depends on the generated runtime call shape from phase 2; can otherwise be developed alongside
     generation-script tests.
4. **Facade migration**
   - Replace manual endpoint requests with four generated operation calls, retain defaults and focused
     projectors, translate generated failures, remove `request()`/`LidarrRequest`, and keep public
     interfaces stable.
   - Add generated-contract, facade, isolation, malformed-response, and HTTP taxonomy tests.
   - Depends on phases 2 and 3.
5. **Boundary and drift enforcement**
   - Extend architecture tests for sole fetch ownership and private generated imports.
   - Add offline drift check to package scripts and CI; add refresh input and tree-comparison tests.
   - Depends on final generated/transport locations from phases 2–4.
6. **Compatibility validation and documentation**
   - Run unchanged action/command/error/tier/index and all-shell completion tests, then typecheck,
     coverage, build, whitespace check, deterministic regeneration, and packed-file inspection.
   - Document generation/refresh/rollback/review; update `ROADMAP.md` with the final PR link.
   - Depends on phases 1–5.
7. **PR review acceptance**
   - Review handwritten trust-boundary diffs separately from machine output; verify both CRITICAL
     controls and all HIGH-risk mitigations have direct test evidence; regenerate independently from
     the pinned inputs and confirm zero drift.
   - Depends on all implementation and validation phases. Any CRITICAL failure returns to phase 3 or
     4 and blocks merge.

No child implementation issue is required if all phases fit one coherent PR. Create a child only if
the publication/licensing decision, upstream-refresh bot, live-container test, or measured filtering
work needs separate ownership; bot automation, live testing, and optimization are explicitly safe to
defer, while the two CRITICAL transport controls are not.

## Key Decisions Needed

1. Approve local `@hey-api/openapi-ts` generation and formally reject current TsArr for production.
2. Confirm whether commit `3e2858439ff35b372d0af00bcea1b0a357572d26` is the initial supported
   snapshot or select an immutable release/deployed-version commit instead.
3. Preserve Node `>=22.0.0` and select exact `@hey-api/openapi-ts@0.93.0`, or intentionally change the
   engine/tooling floor in a separate decision. Do not silently require Node 22.18+.
4. Approve full private SDK generation initially, with filtering allowed only after measured cost and
   a deterministic fail-closed design.
5. Approve the security ownership split: generated endpoints/serialization; handwritten final Fetch
   policy and focused runtime projectors.
6. Decide and document the GPL-3.0-labelled spec/generated-output attribution and npm publication
   treatment before release.
7. Keep upstream refresh manual for #194, or explicitly authorize a least-privilege reviewed bot PR;
   ordinary PR CI remains offline either way.

## Open Questions

- Which exact `@hey-api/client-fetch` version is emitted or required by
  `@hey-api/openapi-ts@0.93.0`, and can it be pinned and injected without any secret-bearing client
  configuration?
- Does the generated wanted operation serialize exactly the current four supplied query fields and
  omit `sortDirection`, `includeArtist`, and `monitored` when unset?
- Can the hardened transport safely reconstruct bounded success/error `Response` objects for the
  pinned generated runtime while preserving status, headers needed for `Retry-After`, and abort
  semantics?
- Is the 8 MiB success cap large enough for the largest supported artist library, or should a
  separately documented configurable cap be considered?
- Is `rfmedia` currently or imminently published to npm, and what exact notice/files policy is
  approved for the vendored spec and compiled generated output?
- What measured thresholds for tracked/packed size, typecheck time, memory, or cold-start latency
  would justify operation filtering?
- Should a future drift workflow notify, upload an artifact, or open a PR, and who owns review of
  schema and generated diffs?
- Which pinned Lidarr container versions, if any, should supplement mocked contract tests after #194?
