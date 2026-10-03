# Integration Analysis

## Executive Summary

Issue #194 can be integrated without changing the `rfmedia lidarr` command surface, configuration
schema, action contracts, reliability tiers, or shell completions. The repository already has the
correct stable chain:

`commands/lidarr.ts -> actions/lidarr/* -> LidarrClientApi -> LidarrClient`

The change belongs below `LidarrClientApi`. A private, per-instance generated client will own paths,
verbs, query serialization, and wire models. `client.ts` will select the four generated operations and
project untrusted results into the existing domain types. A new `transport.ts` will become the sole
authenticated Lidarr Fetch owner and will retain the existing origin, credential, redirect, timeout,
body-limit, UTF-8, delay, redaction, and error-classification policies.

The repository is an npm workspace with one root lockfile. The generator belongs as an exact
development dependency of the `rfmedia` workspace, not the root and not production. Inspection of
`@hey-api/openapi-ts@0.93.0` shows that its Fetch client plugin defaults to `bundle: true`: the runtime
client source can be committed inside the generated tree and does not require an
`@hey-api/client-fetch` production dependency. The config should make that default explicit. If the
toolchain spike deliberately chooses `bundle: false`, the exact emitted/imported client version must
instead be added as a production dependency and recorded in the manifest; mixing the two modes is not
acceptable.

Normal install, typecheck, test, build, and PR CI remain offline with respect to GitHub and Lidarr.
Only an explicit immutable-ref refresh command may use the network. CI should run a non-mutating
generated-tree check immediately after `npm ci`, before the existing `rf-common` build and expensive
rfmedia validation.

## External Services

The only upstream API input is the complete official Lidarr v1 OpenAPI document at
`Lidarr/Lidarr`, path `src/Lidarr.Api.V1/openapi.json`, pinned initially to full commit
`3e2858439ff35b372d0af00bcea1b0a357572d26`. The manifest must record the commit-pinned raw URL,
repository, exact path, upstream Git blob SHA, and exact-byte SHA-256. The mutable `develop` URL is a
discovery aid only and must never be a generation or CI input.

The snapshot must continue to contain these operations and response shapes:

| Stable facade method | Generated operation candidate | Upstream path                | Required compatibility                                    |
| -------------------- | ----------------------------- | ---------------------------- | --------------------------------------------------------- |
| `getSystemStatus()`  | `getApiV1SystemStatus`        | `GET /api/v1/system/status`  | Direct validated status projection                        |
| `getHealth()`        | `getApiV1Health`              | `GET /api/v1/health`         | Validated health array and enum                           |
| `listArtists()`      | `getApiV1Artist`              | `GET /api/v1/artist`         | Full artist list; action-layer filtering remains          |
| `getWantedMissing()` | `getApiV1WantedMissing`       | `GET /api/v1/wanted/missing` | Page 1, size 50, `releaseDate`; omit unset sort direction |

Because the upstream document has no `operationId` fields, the names above are generator-derived.
The first generation spike must compile against the actual emitted names and types; they must not be
copied into actions, commands, public barrels, or tests above the client facade.

Use exact `@hey-api/openapi-ts@0.93.0`. Its published engine is Node `>=20.19.0` and its TypeScript
peer is `>=5.5.3`, which fits `rfmedia`'s declared Node `>=22.0.0` and workspace TypeScript. Configure
the built-in plugins explicitly: TypeScript models, SDK operations, and
`@hey-api/client-fetch` with `bundle: true`. Configure `output.importFileExtension: ".js"` and
`output.tsConfigPath: "./tsconfig.json"`. The generated Fetch runtime accepts a custom `fetch`, but
its ordinary success/error parsing is unbounded and its normal redirect behavior is not the
application policy; the hardened injected transport therefore remains mandatory.

TsArr stays documentation/spike evidence only. It must not enter `dependencies` or the lockfile:
`tsarr@2.12.0` declares Node `>=24.16.0`, exposes generator envelopes, and failed two-instance
origin/key isolation. The first fallback is exact-pinned `openapi-typescript` plus `openapi-fetch` if
the Hey API spike cannot prove NodeNext imports, per-instance construction, custom Fetch injection,
and bounded reconstructed-response compatibility.

The runtime must select only `X-Api-Key` header authentication. The query `apikey` scheme present in
the official spec must remain unused, and generated security helpers must receive no credential.

## Internal Integration Points

The runtime dependency direction after implementation is:

```text
commands/lidarr.ts
  -> actions/lidarr/{status,list,wanted,health}.ts
  -> lib/lidarr/client.ts (LidarrClientApi and stable facade)
  -> lib/lidarr/generated/* (private operations and wire models)
  -> lib/lidarr/transport.ts (injected final Fetch policy)
  -> Lidarr
```

Existing files that must change:

| Existing path                                                     | Integration change                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/rfmedia-cli/src/lib/lidarr/client.ts`                   | Keep `LidarrClient`, `LidarrClientApi`, `LidarrWantedQuery`, operation labels, defaults, and dependency seam. Create one generated client per `LidarrClient`, inject the hardened Fetch closure, call four named generated operations, unwrap privately, validate/project, and translate failures. Remove `LidarrRequest`, public generic `request()`, literal paths, verb/query assembly, and the in-file transport implementation.                                     |
| `packages/rfmedia-cli/src/lib/lidarr/types.ts`                    | Keep frozen connection settings, module-private `WeakMap` credentials, `StaticLidarrApiKeyProvider`, request policy settings, and focused runtime guards/projectors. Remove `LidarrQueryValue` after the generic query builder disappears. Update comments from handwritten wire ownership to stable domain projections.                                                                                                                                                 |
| `packages/rfmedia-cli/src/types/lidarr.ts`                        | Keep every exported interface source-compatible. Reword documentation so these are command-facing domain projections, not full wire schemas. Do not alias or re-export generated types.                                                                                                                                                                                                                                                                                  |
| `packages/rfmedia-cli/src/lib/lidarr/index.ts`                    | Preserve URL/config/override resolution and construction behavior. It continues to instantiate `LidarrClient` plus the off-object key provider; generated configuration must not be exposed from this barrel.                                                                                                                                                                                                                                                            |
| `packages/rfmedia-cli/src/lib/lidarr/errors.ts`                   | Remain authoritative for error codes, retryability, status, and `Retry-After`. Accept only sanitized transport/generated metadata; never attach generated `Request`, `Response`, error body, options, or raw parser/fetch causes.                                                                                                                                                                                                                                        |
| `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`              | Retain generated-operation URL/query/default tests, runtime projection/guard failures, HTTP taxonomy, and direct domain returns. Remove tests of the retired arbitrary `request()` method.                                                                                                                                                                                                                                                                               |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`      | Move the Lidarr fetch owner from `src/lib/lidarr/client.ts` to `src/lib/lidarr/transport.ts`. Add a private-generated-import rule: internal generated files may import one another, but the only non-generated production importer of `src/lib/lidarr/generated/*` is `src/lib/lidarr/client.ts`. Generalize function names and console text from Plex-only wording while retaining the existing script path and package command to avoid unrelated documentation churn. |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs` | Update owner fixtures to `transport.ts`; add allowed `client.ts -> generated/*`, allowed generated-internal imports, rejected action/command/helper imports, zero/multiple Lidarr Fetch site cases, and the real-tree assertion.                                                                                                                                                                                                                                         |

New handwritten paths, explicitly:

| New path                                                         | Purpose                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/lidarr/transport.ts`               | Generated-client-compatible Fetch closure; final URL/header validation, late key retrieval/injection, redirect rejection, composed abort/timeout, bounded streams, fatal UTF-8, delay, and sanitized failures. |
| `packages/rfmedia-cli/src/lib/lidarr/transport.test.ts`          | Existing and expanded request-security/body-limit/cancellation tests, including interleaved clients and body-read timeout/abort cases.                                                                         |
| `packages/rfmedia-cli/src/lib/lidarr/generated/`                 | Replace-only generated Fetch client, SDK operations, and wire models. The directory is private, committed, and compiled with the package.                                                                      |
| `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts` | Small NodeNext/runtime contract proving instance creation, Fetch injection, four operation exports, representative model imports, and isolation.                                                               |
| `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`  | Durable TsArr decision record plus regeneration, check, immutable refresh, review, rollback, ownership, and validation runbook.                                                                                |
| `packages/rfmedia-cli/THIRD_PARTY_NOTICES.md`                    | Upstream Lidarr spec provenance/license notice and attribution for bundled generated/runtime material, subject to maintainer-approved wording.                                                                 |

`LidarrClientDependencies.fetch` currently accepts only `string | URL`; the generated runtime may
invoke the custom Fetch with a `Request`. Widen that seam to a `typeof fetch`-compatible signature and
adapt existing mocks to inspect `new Request(input, init)` consistently. Keep timer, delay, and body
limit overrides in the same dependency object rather than creating a second gateway abstraction.

No changes are expected in `src/actions/lidarr/*`,
`src/actions/test-helpers/lidarr-client-mocks.ts`, `src/commands/lidarr.ts`,
`src/lib/lidarr/tiers.ts`, or `src/lib/lidarr/index.ts` public exports. In particular,
`runHealthGate()` currently accepts the concrete `LidarrClient`; the class remains in place, so no
downstream signature change is necessary.

## Build and Tooling

New source/tool inputs, explicitly:

| New path                                                       | Build/tool role                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/openapi/lidarr-v1.json`                  | Complete immutable upstream snapshot.                                                                                                                                                                                                                                                                               |
| `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`         | Versioned provenance/digest/tool contract with no timestamp or machine data. For bundled Fetch, record generator `0.93.0`, client plugin `@hey-api/client-fetch`, and `bundle: true`; the generated runtime bytes are then pinned by generator/config/snapshot/lockfile rather than a separate npm runtime version. |
| `packages/rfmedia-cli/openapi-ts.config.mjs`                   | One fixed local-input/full-SDK job, NodeNext `.js` imports, package tsconfig, bundled Fetch client, clean temporary output, deterministic header/post-processing.                                                                                                                                                   |
| `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`      | `write` and `check` orchestration, manifest/digest/required-operation validation, temp generation, deterministic formatting, exact path confinement, atomic replacement, and full tree comparison.                                                                                                                  |
| `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs` | `node:test` coverage for invalid manifest/digest, path confinement, deterministic reruns, unchanged check mode, and changed/missing/extra/type/symlink drift.                                                                                                                                                       |
| `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.mjs`      | Explicit network-only immutable `--ref` refresh, allowlisted repository/path download, input cap, local-only `$ref` validation, manifest update, and regeneration.                                                                                                                                                  |
| `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.test.mjs` | Local fixtures/mocked Fetch for ref validation, provenance, size/reference/operation/security rejection, and all-or-nothing writes; no real network in tests.                                                                                                                                                       |

`packages/rfmedia-cli/package.json` is the only package manifest that needs dependency/script edits:

- add exact dev dependency `"@hey-api/openapi-ts": "0.93.0"`;
- add `codegen:lidarr` for mutating local-snapshot generation;
- add `codegen:lidarr:check` for read-only temporary generation and byte comparison;
- add `openapi:lidarr:refresh` for the explicit `--ref` network workflow;
- add `test:codegen:lidarr` for both `.mjs` script test files;
- include the offline check in both `pretypecheck` and `prebuild`; retain architecture checks/tests;
- do not add generation to `install`, `postinstall`, `prepare`, runtime `start`, or normal `build`;
- do not add a root `package.json` wrapper: existing npm workspace syntax already gives one stable
  command, for example `npm run codegen:lidarr --workspace packages/rfmedia-cli`.

`package-lock.json` is lockfile version 3 and is the sole lockfile because package-local lockfiles are
ignored. Regenerate it from the repository root. The change must update the
`packages/rfmedia-cli` workspace record with the exact generator dev dependency and add the
generator's resolved `node_modules/@hey-api/*`/support graph with integrity metadata. With explicit
Fetch bundling there should be no `@hey-api/client-fetch` production dependency in the workspace
record. Review lifecycle scripts, engines, licenses, integrity fields, and unexpected non-dev edges
in the lock diff.

No TypeScript configuration edit should be required. `packages/rfmedia-cli/tsconfig.json` already
uses `target: ES2023`, `module`/`moduleResolution: NodeNext`, strict flags, declarations, and
`include: ["src/**/*.ts", "src/**/*.tsx"]`; therefore the generated tree and generated-contract test
are automatically typechecked, while only production generated source is emitted during `tsc`.
Existing code already compiles platform `fetch`, `Request`, `Response`, `URL`, `AbortController`, and
`TextDecoder` with `lib: ["ES2023"]` plus `@types/node`, so adding `DOM` would broaden the ambient type
surface unnecessarily. Point generator config at this tsconfig and fail the spike if emitted code
needs weaker flags or a lib change.

The generation wrapper should invoke the workspace-local generator executable and the root-locked
Prettier (`3.8.1` in the current lockfile), never an unversioned `npx`. It must generate into a fresh
temporary directory first because the generator's own `clean` behavior recursively removes its
configured output. Only after realpath/symlink confinement, operation assertions, optional compile
smoke, and deterministic formatting may write mode atomically replace exactly
`src/lib/lidarr/generated/`. Check mode compares sorted relative paths, entry types, and bytes and
must leave both tracked and untracked checkout state untouched.

## CI and Drift

`.github/workflows/rfmedia-cli.yml` already pins actions by SHA, sets
`permissions: contents: read`, disables checkout credential persistence, runs Node 22, uses `npm ci`,
and triggers for package/root-manifest/lockfile changes. Preserve all of those controls.

In the `test` job, add these steps directly after `Install dependencies` and before `Build rf-common`:

1. `Test Lidarr code generation tooling` ->
   `npm run test:codegen:lidarr --workspace packages/rfmedia-cli`.
2. `Check generated Lidarr client drift` ->
   `npm run codegen:lidarr:check --workspace packages/rfmedia-cli`.

The explicit early steps provide focused diagnostics even though `pretypecheck` later exercises the
drift gate again. The benchmark job should not regenerate or contact upstream; it may rely on
committed output after `npm ci`. Ordinary CI must not receive Lidarr credentials and must not contact
GitHub raw content or a Lidarr instance.

Check mode must verify all of the following as one offline contract: snapshot digest matches the
manifest; repository/path/commit/config/tool fields are exact; the spec contains only local `$ref`
targets and the four required read operations/security declarations; generation succeeds from the
local snapshot; a second generation is byte-identical; committed output has no changed, missing,
extra, non-file, or symlink entries. Failure output should list relative file categories and print the
exact workspace regeneration command without dumping the full generated diff.

Refresh is intentionally outside ordinary CI. The supported local command requires an immutable
`--ref`, resolves it to a full SHA in allowlisted `Lidarr/Lidarr`, downloads only
`src/Lidarr.Api.V1/openapi.json` at that SHA, validates before writing, updates the manifest, invokes
the same generator, and leaves snapshot/generated/handwritten diffs for review. A scheduled bot,
automatic PR, live-container contract, or upstream freshness gate is a later issue unless separately
authorized; it must never use `pull_request_target` or auto-merge generated changes.

## Packaging and Licensing

`packages/rfmedia-cli/package.json` is not marked `private` and declares MIT, but it currently has no
`files` allowlist, `publishConfig`, package-local `LICENSE`, or notice file. The package `.gitignore`
does not exclude a future `openapi/` or `src/lib/lidarr/generated/` tree. Consequently an npm tarball
can include the OpenAPI snapshot, manifest, scripts, TypeScript source, and compiled generated runtime
in addition to `dist`; packaging behavior must be measured, not assumed.

The upstream OpenAPI document identifies GPL-3.0, while `@hey-api/openapi-ts` and its bundled Fetch
client are MIT. This issue must add approved attribution/provenance in
`packages/rfmedia-cli/THIRD_PARTY_NOTICES.md` and the OpenAPI manifest, and the generated header must
identify its generator and regeneration command without volatile timestamps. This analysis does not
determine whether the spec or derived output changes the package's license; maintainers must approve
the treatment before any npm publication.

Run `npm pack --dry-run --workspace packages/rfmedia-cli` after build and inspect the complete file
list and byte sizes. Record whether the snapshot, notice, generated TypeScript, compiled JavaScript,
declarations, maps, and source maps are present. Do not publish as part of #194. If maintainers decide
to add a `files` allowlist, make that a deliberate `packages/rfmedia-cli/package.json` change based on
the approved source/notice distribution policy and add a tarball-content assertion; do not silently
exclude attribution while retaining compiled generated code.

The bundled-client choice reduces runtime supply-chain and installation surface: there is no new
runtime npm package, and the exact runtime source is reviewable in the generated diff. It increases
tracked/compiled/tarball size, so record generated tree size, pack size, typecheck duration, and cold
`rfmedia --help` timing. Filtering or externalizing the client is justified only by a measured
regression and requires renewed determinism, licensing, and transport review.

## Compatibility Boundaries

The four `LidarrClientApi` signatures and direct validated returns are invariant. Generated
`{ data, error, request, response }` envelopes remain inside `client.ts`; generated names and types do
not enter `src/actions`, `src/commands`, `src/types/index.ts`, or `lib/lidarr/index.ts` exports.

Behavior that existing downstream tests must continue to prove:

- `status` still performs system-status and artist-list reads concurrently through one isolated
  client and produces the same aggregate fields;
- `list` still fetches the full artist array and performs monitored/tag/profile/limit/offset behavior
  in the action layer;
- `wanted` still supplies only `page`, `pageSize`, `sortKey`, and optional `sortDirection`, using
  defaults `1`, `50`, and `releaseDate`; it must not begin sending `includeArtist`, `monitored`, or
  the query API key;
- `health` still returns the existing `ok | notice | warning | error` projection and remains a report,
  not an exit-code gate;
- `resolveRequiredLidarrClient`, CLI URL/key override precedence, base URL rejection, timeout config,
  error codes/retryability/`Retry-After`, and `local-only` tier behavior stay unchanged;
- caller abort reasons remain identical, timeouts cover header and body reads, and separate clients
  remain isolated under interleaved/concurrent calls;
- command names, flags, help, human output, machine envelope discriminators, empty states, and exit
  handling stay unchanged.

The Bash, Zsh, and Fish templates are tracked TypeScript source rather than derived from Commander at
build time. They must remain byte-for-byte unchanged because #194 adds no command, flag, enum, or
accepted value. Run `src/lib/shell-completions/templates.spec.ts` unchanged and retain the existing
command tests that assert `status`, `list`, `wanted`, and `health`. A no-op template edit is a
compatibility regression in review quality, not required maintenance.

Minimum downstream validation is: generator script tests; offline drift; architecture script/tests;
focused `transport`, `client`, generated-contract, `index`, `errors`, and `tiers` tests; all Lidarr
action tests; `commands/lidarr.test.ts`; shell completion parity; package typecheck; full rfmedia
coverage; package build; `git diff --check`; and dry-run pack inspection. Run the package under Node
22 as CI does; the current developer checkout using a newer Node version is not evidence for the
declared floor.

`ROADMAP.md` must mark only #194 shipped after implementation, review, and green CI, with the final PR
link. It must continue to show #195, #196, mutations, discovery, and reconciliation as open. The
current generated-client checklist appears in the Sprint 3 table, the layered integration checklist,
and the Phase A issue table; update all three consistently without changing later issue state.

## Integration Risks

| Risk                                                                            | Integration consequence                                             | Required control/evidence                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generated auth/default redirect bypasses application policy                     | Credential leak, redirect forwarding, or shared-client cross-talk   | No key in generated config; final transport validates URL/headers before late key retrieval, injects one `X-Api-Key`, forces `redirect: "error"`, and passes two-client interleaving tests.                                          |
| Bundled generated client eagerly parses an unbounded response                   | Memory exhaustion and timeout bypass during body streaming          | Transport reads/caps success at 8 MiB and errors at 4 KiB, keeps abort active, rejects invalid UTF-8, and returns only a bounded reconstructed `Response`. Test missing/false lengths, chunking, expansion, stalls, and body aborts. |
| Generated types are trusted at runtime                                          | Malformed optional/null values escape into commands                 | Treat result data as `unknown`; retain strict focused guards/projectors and construct fresh domain objects.                                                                                                                          |
| Generated envelopes or raw causes escape                                        | API key, URL, headers, or hostile body appears in errors/logs/JSON  | Unwrap in `client.ts`; map fixed messages plus safe status/`Retry-After`; never return or attach raw generated/fetch/parser objects.                                                                                                 |
| Tool config relies on implicit bundled-client behavior                          | Generator upgrade silently externalizes or changes runtime          | Set `@hey-api/client-fetch` and `bundle: true` explicitly; record it in the manifest; inspect generated imports and lockfile on every tool upgrade.                                                                                  |
| Full generated tree violates architecture audit                                 | False positives or an accidental upper-layer import bypass          | Permit generated-internal imports only, authorize `client.ts` as the sole external generated importer, and move exact Fetch ownership to `transport.ts` with fixture tests.                                                          |
| Drift check compares only Git-tracked text                                      | Extra, deleted, symlink, or type-changed files evade CI             | Fresh-temp generation and recursive relative path/type/byte comparison; non-mutating check-mode tests for every discrepancy class.                                                                                                   |
| Generator cleanup escapes its boundary                                          | Destructive deletion outside generated directory                    | Fixed package-relative paths, realpath checks, symlink rejection, disposable output, validation before atomic replace, and no path overrides from spec/env/CLI.                                                                      |
| Mutable or malicious OpenAPI input drives codegen                               | Nondeterminism, external `$ref` fetch, or generated code compromise | Immutable allowlisted ref/path, size cap, local-only refs, exact digest/blob provenance, required-operation/security validation, reviewed diffs, and no network in normal CI.                                                        |
| Workspace dependency is added in the wrong place                                | Root tooling/runtime pollution or incomplete lock coverage          | Exact dev dependency only in `packages/rfmedia-cli/package.json`; regenerate root lockfile; assert no new runtime dependency when bundling.                                                                                          |
| NodeNext output weakens compiler settings                                       | Build passes only with extension or strictness exceptions           | Point config to package tsconfig, force `.js` imports, add generated contract test, and reject any need to relax strict flags or add `DOM`.                                                                                          |
| Snapshot/generated output is unintentionally published under incomplete notices | Licensing/compliance and package-size risk                          | Add approved notices/provenance, inspect `npm pack --dry-run`, perform no publication in #194, and require explicit maintainer approval before release.                                                                              |
| Full SDK materially increases startup/build/package cost                        | Slower CLI and larger tarball                                       | Direct operation imports, baseline measurements, and filtering only after a recorded threshold is exceeded.                                                                                                                          |
| Implementation changes shell templates despite no CLI change                    | Needless completion churn and reinstall burden                      | Leave all three templates unchanged and use their existing parity tests as affirmative evidence.                                                                                                                                     |
