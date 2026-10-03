## Executive Summary

Issue #194 should be implemented as a transport replacement behind the existing Lidarr seam, not
as a new client framework. The repository already has the application-facing contract,
configuration resolution, credential isolation, runtime response guards, error taxonomy, action
mocks, and command/completion regression tests needed to keep the change controlled. The missing
piece is a regenerable owner for endpoint paths, verbs, query serialization, and wire DTOs.

The smallest durable design is:

1. Check in the complete, commit-pinned Lidarr OpenAPI document and a deterministic provenance
   manifest.
2. Use an exact-pinned, development-only `@hey-api/openapi-ts` dependency to generate and commit a
   private Fetch SDK under `src/lib/lidarr/generated/`.
3. Keep one handwritten transport policy module for origin pinning, header-only credentials,
   redirect rejection, timeouts/cancellation, bounded bodies, strict JSON handling, delay, and
   redaction.
4. Keep `LidarrClientApi` and the four explicit `LidarrClient` methods as the action-facing facade.
   Each method calls one generated operation, validates/projects the result to the existing domain
   type, and translates failures through `errors.ts`.
5. Make normal generation and CI drift checks offline and deterministic; make upstream refresh a
   separate explicit network operation.

Generate the full SDK from the full upstream specification initially. The observed specification
has 161 paths and 141 schemas, but a filtering/preprocessing pipeline would introduce another
hand-maintained operation allowlist, transitive-schema logic, and a second source of drift just as
the Lidarr epic is expected to add endpoints. Keep the full generated tree private and measure its
compiled size and CI cost. Add declarative filtering only if measured cost becomes material; never
filter by editing the upstream snapshot or generated files.

Do not change `commands/lidarr.ts` or the Bash, Zsh, and Fish templates. Code generation is an npm
maintenance workflow, not an `rfmedia` command. The existing completion parity tests should pass
unchanged and are the proof that no completion update is required.

## Existing Reusable Code

| Existing path / symbol                                                                                                                           | Reuse decision                                | Concrete guidance                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/lidarr/client.ts` — `LidarrClientApi`                                                                              | Keep unchanged                                | Its four methods are the correct capability seam for actions. Do not expose generated operation names, result envelopes, or models above this interface.                                                                                                                                                                                          |
| `client.ts` — `LidarrWantedQuery` and defaults                                                                                                   | Keep unchanged                                | Preserve page `1`, page size `50`, sort key `releaseDate`, and omission of an unset `sortDirection`. Do not start sending generated/server options such as `includeArtist` or `monitored` unless separately justified; the current request contract omits them.                                                                                   |
| `client.ts` — `LidarrClientDependencies`                                                                                                         | Reuse as the test seam                        | Pass its fetch, delay, timer, and body-limit overrides into the handwritten transport factory. Broaden the injected fetch input type to accept `Request` if the generated Fetch client requires it, rather than creating a second dependency container.                                                                                           |
| `client.ts` — `LidarrRequest` and public `request()`                                                                                             | Retire                                        | They expose the handwritten path/query escape hatch that issue #194 is meant to remove. Only tests use them today. Move their policy behavior to transport tests and let production endpoint identity come only from generated operations.                                                                                                        |
| `packages/rfmedia-cli/src/lib/lidarr/types.ts` — `createLidarrConnectionSettings()`, `getLidarrConnectionApiKey()`, `StaticLidarrApiKeyProvider` | Keep                                          | The frozen connection plus module-private `WeakMap` is the strongest existing secret boundary. The generated client must not store the API key in a reflected headers/config object; the injected transport should obtain and add it per request.                                                                                                 |
| `types.ts` — `isLidarrSystemStatus()`, `isLidarrArtistArray()`, `isLidarrWantedPage()`, `isLidarrHealthArray()` and nested guards                | Keep behavior                                 | Generated TypeScript declarations do not validate runtime JSON. Retain these focused guards, update their comments from “wire types” to “domain projections,” and type their input as `unknown` or the generated model without weakening required-field checks.                                                                                   |
| `packages/rfmedia-cli/src/types/lidarr.ts` — domain interfaces                                                                                   | Keep source-compatible                        | These are narrow command-facing projections even though the current file calls them wire contracts. Correct the documentation, but do not alias the public types directly to broad generated models or export the generated tree from `src/types/index.ts`.                                                                                       |
| `packages/rfmedia-cli/src/lib/lidarr/errors.ts` — `LidarrError`, `classifyLidarrStatus()`, `parseRetryAfter()`                                   | Keep authoritative                            | Map generator/transport failures once into this taxonomy. Preserve status, retryability, `Retry-After`, timeout identity, invalid-response behavior, and body/credential redaction. Do not add generator-specific error classes to actions.                                                                                                       |
| `packages/rfmedia-cli/src/lib/lidarr/index.ts` — `createLidarrClient()`, `resolveRequiredLidarrClient()`                                         | Keep unchanged externally                     | Preserve config/CLI override precedence, optional versus required behavior, URL normalization, and typed configuration failures. Construction should still create one isolated client per resolved connection.                                                                                                                                    |
| `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`                                                                           | Keep unchanged                                | `createLidarrClientMock()` already proves actions depend on only the four-method interface. No action test should import or mock a generated operation.                                                                                                                                                                                           |
| `packages/rfmedia-cli/src/actions/test-helpers/lidarr-fixtures.ts`                                                                               | Keep as domain fixtures                       | Use these for action tests. Keep raw/generated response fixtures local to client/transport tests so wire shapes do not leak into workflow tests.                                                                                                                                                                                                  |
| `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`                                                                                             | Reuse cases, split by responsibility          | Move request-policy cases to `transport.test.ts`; retain exact generated operation URLs, wanted defaults, domain validation, and error translation in `client.test.ts`. Add two-client isolation without rewriting the existing action suites.                                                                                                    |
| `packages/rfmedia-cli/src/lib/lidarr/index.test.ts`, `errors.test.ts`, `tiers.test.ts`                                                           | Run unchanged                                 | They protect connection resolution and failure/tier contracts that codegen must not alter.                                                                                                                                                                                                                                                        |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and `.test.mjs`                                                                     | Extend the existing simple architecture guard | Authorize the one Lidarr fetch site in `transport.ts` instead of `client.ts`, and reject generated imports from any production module except `lib/lidarr/client.ts`. Keep the current package-relative scan, exact owner count, `node:test` fixtures, and temporary-directory cleanup pattern. A new architecture-lint dependency is unnecessary. |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`                                                                               | Use as no-change evidence                     | Lines covering `lidarr` already lock `status`, `list`, `wanted`, and `health` across Bash, Zsh, and Fish. Run this test unchanged; do not edit templates when no command/flag changed.                                                                                                                                                            |
| `packages/rfmedia-cli/package.json`, root `package-lock.json`, `.github/workflows/rfmedia-cli.yml`                                               | Extend existing gates                         | Add explicit generation, drift-check, and refresh scripts. Keep the generator dev-only and exact-pinned. Ordinary typecheck/test/build and PR CI must consume the checked-in spec/output without network access.                                                                                                                                  |

## Modularity Design

Use modules that each have one reason to change:

```text
packages/rfmedia-cli/
├── openapi/
│   ├── lidarr-v1.json                 # complete upstream snapshot; never hand-filtered
│   └── lidarr-v1.manifest.json        # commit, source path/URL, digest, tool/config version
├── openapi-ts.config.mjs              # one pinned Lidarr generation job
├── scripts/
│   ├── generate-lidarr-client.mjs     # write/check modes from local inputs
│   └── refresh-lidarr-openapi.mjs     # explicit network refresh only
└── src/lib/lidarr/
    ├── generated/                     # machine-owned SDK and wire models
    ├── transport.ts                   # handwritten authenticated Fetch policy
    ├── client.ts                      # LidarrClientApi facade + four generated calls
    ├── types.ts                       # connection/credential state + focused domain guards
    ├── errors.ts                      # stable error taxonomy
    ├── index.ts                       # config resolution/composition
    └── tiers.ts                       # unchanged reliability tiers
```

`transport.ts` should expose one small factory, such as
`createHardenedLidarrFetch(connection, apiKeyProvider, dependencies)`, whose return type is
compatible with the generator's custom-fetch option. It verifies every generated request still
targets `connection.origin`, rejects authentication-like query material, obtains the API key at
request time, adds `X-Api-Key`, forces `redirect: "error"`, composes timeout/caller cancellation,
bounds and strictly decodes bodies, and never includes raw bodies or credentials in errors.

`client.ts` should create one generated client instance per `LidarrClient`. Its four methods select
generated operations, provide the established defaults, invoke focused guards, and return stable
domain values. It should not contain a URL path literal, HTTP verb, generic query serializer, or
second request primitive.

Do not add a `GeneratedLidarrGateway` interface mirroring all four `LidarrClientApi` methods. It
would duplicate the existing mock seam without isolating another volatile dependency: the
generated SDK already supplies typed operation functions, and `LidarrClientDependencies.fetch`
already supplies the lower test seam. Likewise, do not move this into the provider-neutral
`MediaServerAdapter`; Lidarr deliberately has a distinct error/tier model and later Lidarr issues
are not Plex adapter implementations.

The generated directory is private infrastructure. In production source, only `client.ts` should
import it. `transport.ts` must depend only on platform Fetch types, Lidarr connection settings, and
Lidarr errors, which keeps security policy testable without loading generated code.

## KISS Assessment

| Area                     | Simplest sufficient choice                                           | Avoid                                                       | Reason                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Client strategy          | Local generated Fetch SDK behind `LidarrClientApi`                   | TsArr runtime dependency plus another compatibility wrapper | TsArr's supported Node floor and shared mutable client conflict with current requirements.                                                     |
| Specification            | Commit the complete upstream OpenAPI snapshot                        | A four-path hand-edited spec                                | The complete snapshot makes provenance and upstream diffs honest; editing it creates a forked contract.                                        |
| Generated scope          | Generate the full private SDK initially                              | Custom operation/schema filtering before cost is measured   | Full generation is one deterministic tool invocation and supports the planned Lidarr epic; filtering adds maintenance machinery.               |
| Runtime validation       | Keep the four focused guards and nested helpers                      | Generate validators for all 141 schemas                     | Only four projections cross the application boundary today. Full runtime-schema generation adds runtime/output cost without current consumers. |
| Policy boundary          | One custom fetch factory in `transport.ts`                           | A general HTTP middleware framework                         | Native Fetch plus existing helpers already covers the required policy.                                                                         |
| Application interface    | Four explicit methods                                                | A generic `call(operation, params)` or operation registry   | Explicit methods preserve mocks, defaults, return types, and readable error labels.                                                            |
| Codegen workflow         | Two local modes (`write`, `check`) plus one explicit refresh command | Code generation during every runtime start/install          | Generated source is committed; users and production do not need the generator or network.                                                      |
| Drift check              | Generate in a temporary directory and byte-compare sorted trees      | Generate in place then rely on a dirty Git worktree         | CI should not mutate tracked files, and a tree comparison catches additions and deletions.                                                     |
| Architecture enforcement | Extend the existing Node script                                      | ESLint architecture plugin or dependency graph framework    | The repository already has a tested import/fetch boundary scanner.                                                                             |
| Error handling           | Existing `LidarrError` classes                                       | Re-export generator result/error envelopes                  | Stable domain codes are already consumed and prepared for #195/#196.                                                                           |
| Completion handling      | No template edits; run parity tests                                  | Add a hidden `rfmedia codegen` command                      | This is a maintainer workflow, not operator functionality.                                                                                     |
| Upstream refresh         | Manual/scheduled separate workflow                                   | Fetch `develop` during PR CI                                | Moving network input makes ordinary builds nondeterministic and flaky.                                                                         |

Always retain the full upstream snapshot even if generated output is filtered later. If the first
full generation causes a material package-size, TypeScript-memory, or CI-time regression, establish
an explicit budget and then add a deterministic path+method allowlist with automatically retained
schema references. The filter must be tested to include the four required operations and must fail
closed when a referenced schema cannot be resolved. Until measurement proves that need, it is
over-engineering.

## Abstraction vs. Repetition

Extract or retain abstraction only where it owns policy or blocks generator leakage:

- Extract the existing URL/auth/redirect/timeout/body/redaction machinery from `client.ts` into one
  generated-client-compatible fetch factory in `transport.ts`.
- Keep the `WeakMap` credential binding and `StaticLidarrApiKeyProvider`; do not place the key in a
  generated client's enumerable configuration or default headers.
- Keep the four runtime guards. They describe fields the CLI consumes, not a competing full Lidarr
  schema.
- Keep one manifest validator and one recursive tree comparison in the generation script. Reuse
  those functions in write/check tests rather than implementing separate CI logic.
- Extend the current architecture scanner with Lidarr generated-import ownership. Do not create a
  second scanner that walks the same production tree.

Prefer small explicit repetition when abstraction would hide the contract:

- Four calls to four named generated operations are clearer than an operation-name map, dynamic
  dispatch, or generic gateway.
- Four operation labels and four guard calls may remain beside their facade methods; they carry
  user-visible error context.
- Keep Lidarr and Plex transport implementations separate despite similar timeout/body helpers.
  Their credentials, status taxonomy, retry behavior, and future lifecycle work differ. Share only
  after a second concrete use proves an identical stable contract.
- Keep generated raw fixtures separate for status, health, artists, and wanted. A reflection-based
  fixture factory would obscure which upstream fields each command requires.
- Keep local generation and upstream refresh as separate commands even if they share digest and
  manifest helpers. Their trust and network boundaries are intentionally different.

Remove the public generic `LidarrClient.request()` and `LidarrRequest` instead of adapting them to
generated code. Retaining a manual arbitrary-path API would permit future code to bypass the
generated contract and recreate the maintenance problem.

## Interface Design

The stable interface remains:

```typescript
export interface LidarrClientApi {
  getSystemStatus(signal?: AbortSignal): Promise<LidarrSystemStatus>;
  getHealth(signal?: AbortSignal): Promise<readonly LidarrHealthCheck[]>;
  listArtists(signal?: AbortSignal): Promise<readonly LidarrArtist[]>;
  getWantedMissing(query?: LidarrWantedQuery): Promise<LidarrWantedPage>;
}
```

Interface rules:

- Accept caller `AbortSignal` exactly where it is accepted today and preserve the caller's abort
  reason rather than wrapping it in a generator error.
- Return direct, validated domain bodies. Do not return `{ data, error, request, response }` or raw
  `Response` objects.
- Keep arrays readonly and keep `LidarrWantedQuery` defaults in the facade, not in actions or the
  generated tree.
- Generated operation/type names are private and may change on generator upgrades without action
  churn.
- The API key is transport-owned and header-only. Generated support for the OpenAPI query-key
  security scheme must remain unused.
- Generated result failures must be translated before they leave `client.ts`; callers branch only
  on existing `LidarrError` fields.
- `index.ts` continues to expose configuration construction and the stable client/errors/tiers, but
  must not export `generated/*`.

Only the generated operation defines paths, verbs, query names, and serialization. For
`getWantedMissing()`, the facade supplies `page`, `pageSize`, `sortKey`, and optional
`sortDirection` through the generated typed options. Contract tests—not duplicated strings in
production—verify the emitted URL remains the current one.

## Testability Patterns

Use a layered suite so failures identify which boundary drifted:

| Layer              | Reuse/add                                                                  | Required evidence                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation         | Add tests for `generate-lidarr-client.mjs` plus run `codegen:lidarr:check` | Invalid manifest/digest fails; identical inputs produce identical bytes; check mode leaves the worktree untouched; missing, extra, and changed generated files all fail; required operations are present.                               |
| Generated contract | Add `src/lib/lidarr/generated-contract.test.ts`                            | The generated client imports under NodeNext, constructs per instance, and exposes the four required operations/models. Keep assertions small; do not snapshot the generated tree.                                                       |
| Transport          | Move request-security cases from `client.test.ts` to `transport.test.ts`   | Origin pinning, no auth in URL, exact `X-Api-Key`, redirect rejection, provider failure redaction, strict UTF-8/JSON, bounded success/error bodies, post-response delay, timeout, caller abort identity, and no reflected secret state. |
| Facade             | Adapt `client.test.ts` to mocked Fetch/generated calls                     | Exact four endpoint URLs, wanted query/default omission behavior, focused guard failures, HTTP taxonomy, `Retry-After`, network/timeout mapping, and direct domain returns.                                                             |
| Isolation          | Add a two-client test                                                      | Construct clients for two origins/keys, invoke them interleaved, and prove every request retains its own origin/key. This directly guards the TsArr failure mode.                                                                       |
| Composition        | Run `index.test.ts` unchanged                                              | Config/CLI precedence, invalid URLs, optional factory behavior, and required typed failures remain stable.                                                                                                                              |
| Actions/commands   | Run existing Lidarr action tests and `commands/lidarr.test.ts` unchanged   | Typed mocks still satisfy `LidarrClientApi`; human and JSON results/error text remain unchanged.                                                                                                                                        |
| Architecture       | Extend `check-direct-plex-imports.test.mjs` fixtures                       | Exactly one Lidarr fetch site in `transport.ts`; no other production fetch owner; only `client.ts` imports `generated/*`; real tree passes.                                                                                             |
| Completions        | Run `src/lib/shell-completions/templates.spec.ts` unchanged                | All three shells still expose only `status`, `list`, `wanted`, and `health` with the current options.                                                                                                                                   |

Follow the existing script-test pattern: resolve paths from `import.meta.url`, use
`mkdtempSync(join(tmpdir(), "rfmedia-lidarr-codegen-"))`, clean in `finally`, sort relative POSIX
paths before comparison, and use `node:test`/`node:assert` for `.mjs` scripts. Use native
`fs`, `path`, `os`, `crypto`, and `child_process`; no filesystem/diff helper dependency is needed.

The deterministic generation contract should be explicit:

- The snapshot, manifest, config, exact generator version, lockfile, and Prettier version are inputs.
- The manifest contains schema version, upstream repository/commit/path/URL, spec SHA-256,
  generator package/version, and config version. Do not include the current time, machine path,
  host, or username in generated output.
- Write mode replaces only `src/lib/lidarr/generated/` after successful generation.
- Check mode generates to a temporary directory and performs a byte comparison. It never deletes,
  formats, or rewrites the tracked tree.
- Recursive comparison reports changed, missing, and extra relative paths and prints the exact
  regeneration command.
- Ordinary PR CI invokes check mode from the checked-in snapshot; only the refresh workflow uses
  the network.

The focused validation order should be: generator script tests and drift check; architecture
tests; Lidarr transport/client/index/errors/tiers tests; Lidarr action and command tests; completion
template test; package typecheck; full rfmedia test/coverage; build; `git diff --check`.

## Build vs. Depend

| Need               | Build/reuse                                                                  | Dependency decision                                                                                                         | Rationale                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI generation | Configure local generation from the checked-in spec                          | Add exact `@hey-api/openapi-ts@0.93.0` as a dev dependency, subject to the selected version passing the declared Node floor | A generator is specialized tooling worth depending on; exact pinning and the lockfile make its output reviewable.                   |
| Runtime Lidarr SDK | Commit generated Fetch source                                                | Do not add TsArr as a runtime dependency                                                                                    | Current TsArr support and instance model fail project gates; generated runtime should have no codegen dependency at execution time. |
| HTTP runtime       | Reuse Node 22 Fetch, `URL`, `AbortController`, `TextDecoder`, and `Response` | No HTTP client dependency                                                                                                   | The current security behavior already uses platform APIs and the generator supports injected Fetch.                                 |
| Runtime validation | Reuse focused guards in `types.ts`                                           | Do not add a schema-validation framework or generate validators for the full spec                                           | Four small projections are already tested; full validation would expand runtime output and maintenance.                             |
| Secret storage     | Reuse the frozen connection and private `WeakMap`                            | No secret-manager/DI dependency                                                                                             | This already prevents reflection and serialization leakage while supporting the existing provider seam.                             |
| Drift comparison   | Build a small sorted recursive byte comparator                               | No `diff`, glob, or directory-sync package                                                                                  | Native Node APIs cover the deterministic requirement and avoid platform-specific shell behavior.                                    |
| Digest/provenance  | Use `node:crypto` SHA-256 and a JSON manifest                                | No hashing package                                                                                                          | SHA-256 is built into the supported runtime.                                                                                        |
| Formatting         | Reuse the root locked Prettier configuration/version                         | No generated-code formatter                                                                                                 | One formatting path keeps generated diffs consistent with the repository.                                                           |
| Architecture guard | Extend `check-direct-plex-imports.mjs`                                       | No ESLint/import-boundary plugin                                                                                            | The existing scanner is already run in `pretypecheck`/`prebuild` and has fixture tests.                                             |
| Upstream refresh   | Build one explicit Node script around native Fetch/GitHub metadata           | No scheduled-update service dependency initially                                                                            | A manual or scheduled GitHub workflow can call the same script later without changing generation semantics.                         |

Keep the scripts separate and composable in `packages/rfmedia-cli/package.json`, for example
`codegen:lidarr`, `codegen:lidarr:check`, and `openapi:lidarr:refresh`. Add the offline drift check as
an explicit CI step and to a local validation path that both typecheck and build exercise. Do not
hide a network refresh inside `prebuild`, `pretypecheck`, `prepare`, or `postinstall`.

## Open Questions

1. Which exact upstream revision is the initial compatibility target: the maintainer's deployed
   Lidarr release, a stable release tag, or the already researched `develop` commit
   `3e2858439ff35b372d0af00bcea1b0a357572d26`? The answer belongs in the manifest; a moving branch
   URL is not sufficient.
2. Does repository/package policy require additional GPL-3.0 attribution for the checked-in Lidarr
   OpenAPI document and generated output? Resolve this before publishing the snapshot under the
   package's MIT metadata.
3. Is Node `>=22.0.0` an actual contributor/tooling floor or may development tooling require a
   newer Node 22 patch? The selected exact generator must run on the declared floor, or the engine
   contract must be intentionally updated and tested in a separate decision.
4. Does the pinned generated wanted operation accept the existing four query fields without adding
   `includeArtist` or `monitored`? Preserve the current emitted URL first; any explicit new query
   option is a behavioral change that needs separate evidence.
5. What measured threshold would justify filtered generation: tracked/packed bytes, TypeScript
   compile memory/time, or review burden? Full generation is the default until a recorded
   measurement crosses an agreed threshold.
6. Should upstream drift produce only a workflow artifact/notification or automatically open a PR?
   Either option should call the same refresh script and remain separate from ordinary PR CI.
7. Should a live Lidarr container smoke test be added later? It can supplement generated/mocked
   contracts, but must not be the only compatibility proof or a required source of generation.
