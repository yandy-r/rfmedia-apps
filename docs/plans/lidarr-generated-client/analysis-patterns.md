# Pattern Analysis

## Executive Summary

Issue #194 is a boundary replacement, not a command or action redesign. The repository already has
the correct application seam (`LidarrClientApi`), one-client-per-connection construction, private
credential binding, strict domain guards, stable error classes, typed action mocks, command parity
tests, and cross-shell completion tests. Reuse those contracts and replace only the handwritten
endpoint/request ownership below the facade.

The target dependency direction is:

```text
commands/lidarr.ts
  -> actions/lidarr/*
  -> lib/lidarr/client.ts (stable facade and generated result projection)
  -> lib/lidarr/generated/* (paths, methods, query serialization, wire DTOs)
  -> lib/lidarr/transport.ts (the sole authenticated Fetch owner)
  -> Lidarr
```

Generate the complete SDK from the complete pinned snapshot. Keep it private, committed, and
replace-only. There is no existing code-generation subsystem in this repository to extend; the
closest local precedent is the tested Node architecture script. Follow its package-relative paths,
native Node APIs, temporary fixture directories, deterministic diagnostics, and `node:test` suite,
but implement generation/drift as a separate script rather than adding unrelated behavior to the
architecture scanner.

## Implementation Patterns

### Stable application facade

- `LidarrClientApi` already exposes exactly the four capabilities used by actions at
  `packages/rfmedia-cli/src/lib/lidarr/client.ts:86-116`. Keep the method names, arguments, return
  types, and `AbortSignal` behavior unchanged.
- `LidarrWantedQuery` defines the application contract at `client.ts:72-84`; the current endpoint
  implementation applies page `1`, page size `50`, and sort key `releaseDate`, while omitting an
  absent `sortDirection`, at `client.ts:451-469`. Those are compatibility defaults, not OpenAPI
  defaults, and must remain in the handwritten facade.
- Actions resolve only the facade and domain types. For example, status calls
  `getSystemStatus()`/`listArtists()` at
  `packages/rfmedia-cli/src/actions/lidarr/status.ts:94-110`, while wanted maps CLI `sortDir` to the
  facade's `sortDirection` at `packages/rfmedia-cli/src/actions/lidarr/wanted.ts:83-104`. Generated
  names, option objects, models, and result envelopes must not cross this boundary.
- `createLidarrClient()` and `resolveRequiredLidarrClient()` construct a fresh client for each
  resolved connection at `packages/rfmedia-cli/src/lib/lidarr/index.ts:97-124`. Preserve config/CLI
  precedence and optional-versus-required failure behavior; this construction site is also the
  natural proof that no generated singleton is reused.

### Credential and transport policy

- `createLidarrConnectionSettings()` freezes non-secret connection data and stores the origin/key
  binding in a module-private `WeakMap` at
  `packages/rfmedia-cli/src/lib/lidarr/types.ts:70-112`. `getLidarrConnectionApiKey()` enforces the
  origin binding at `types.ts:114-135`, and `StaticLidarrApiKeyProvider` validates the key only when
  requested at `types.ts:149-198`. Reuse all three rather than placing the key in generated client
  headers, auth configuration, interceptors, or serializable state.
- The current request policy is concentrated in `client.ts`: redaction and bounded messages at
  `client.ts:148-160`, abort/timeout composition at `client.ts:248-279`, streaming body limits at
  `client.ts:281-314`, fatal UTF-8 plus JSON parsing at `client.ts:316-322`, redirect rejection and
  exact `X-Api-Key` injection at `client.ts:376-415`, and error translation at `client.ts:491-547`.
  Move this behavior into `transport.ts`; do not leave a second request path in `client.ts`.
- `LidarrClientDependencies` at `client.ts:48-56` is already the correct injection seam for Fetch,
  delay, timers, and body caps. Retain it and widen only the Fetch input type if the generated client
  passes a `Request` rather than `string | URL`.
- The generated operation must provide the final URL, verb, and serialized query. The hardened Fetch
  closure must then validate the final URL and headers, reject credential-like query keys/values and
  pre-existing `X-Api-Key`/`Authorization`, retrieve the key only after those checks, inject exactly
  one `X-Api-Key`, force `redirect: "error"`, and preserve caller cancellation through body
  consumption.

### Runtime projections and errors

- Generated interfaces are compile-time wire descriptions, not validators. Keep the public narrow
  projections in `packages/rfmedia-cli/src/types/lidarr.ts:31-160`; update their comments from
  handwritten wire contracts to stable domain projections, but do not alias them to broad optional
  generated models or export generated types from a public barrel.
- Reuse the guard behavior in `packages/rfmedia-cli/src/lib/lidarr/types.ts:202-388`. In particular,
  it rejects non-finite numeric fields, malformed nested artist/statistics records, invalid health
  enums, and malformed arrays. The functions may remain type guards accepting `unknown` or become
  explicit projectors from generated models, but required-field strictness must not weaken.
- `LidarrError` and its subclasses are the application taxonomy at
  `packages/rfmedia-cli/src/lib/lidarr/errors.ts:25-202`. Reuse `parseRetryAfter()` and
  `classifyLidarrStatus()` at `errors.ts:204-270`; generator result/error envelopes and exceptions
  must be translated once inside the facade/transport and never reach actions.
- Preserve the current rule that raw bodies are discarded and raw Fetch failures are not attached as
  `cause` because either can contain secrets (`client.ts:539-546`).

### Concrete before/after shape

Current endpoint ownership is handwritten:

```ts
const body = await this.request<unknown>({
  path: "/api/v1/wanted/missing",
  operation: "lidarr wanted missing",
  query: { page, pageSize, sortKey, sortDirection },
  signal,
});
```

The target shape is a private per-instance generated client plus a named generated operation. The
exact generated option/result property names must be proven by the pinned generator spike and
TypeScript, but the application structure should be:

```ts
this.#generatedClient = createClient({
  baseUrl: connection.origin,
  fetch: createHardenedLidarrFetch(connection, apiKeyProvider, dependencies),
});

const result = await getApiV1WantedMissing({
  client: this.#generatedClient,
  query: {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 50,
    sortKey: query.sortKey ?? "releaseDate",
    sortDirection: query.sortDirection,
  },
  signal: query.signal,
});

return projectWantedPage(unwrapGeneratedResult(result, "lidarr wanted missing"));
```

The after-shape must contain no Lidarr path literal, HTTP method, generic query serializer, or public
`request<T>()`/`LidarrRequest` escape hatch in handwritten production code. The generated tree owns
those details; `client.ts` owns only operation selection, application defaults, strict projection,
and error labels.

The transport factory should be a small Fetch-compatible closure rather than another four-method
gateway:

```ts
export function createHardenedLidarrFetch(
  connection: LidarrConnectionSettings,
  apiKeyProvider: LidarrApiKeyProvider,
  dependencies: LidarrClientDependencies = {},
): typeof globalThis.fetch {
  return async (input, init) => {
    // Resolve the generated Request, validate final origin/query/headers, then get the key.
    // Fetch with redirect:error and composed cancellation.
    // Read at most 8 MiB on success or 4 KiB on error using the same active signal.
    // Fatal-decode the bytes and return only a bounded reconstructed Response.
  };
}
```

## Reusable Symbols

| Symbol                                                                                     | Verified location                                                               | Reuse                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LidarrClientApi`                                                                          | `packages/rfmedia-cli/src/lib/lidarr/client.ts:86-116`                          | Keep source- and behavior-compatible; it remains the only action-facing client contract.                    |
| `LidarrWantedQuery` and default constants                                                  | `client.ts:38-42`, `client.ts:72-84`, `client.ts:451-469`                       | Keep defaults and omission semantics in the facade; pass only these four fields to the generated operation. |
| `LidarrClientDependencies`                                                                 | `client.ts:48-56`                                                               | Reuse for transport tests; widen the Fetch input signature only as required by generated output.            |
| `createLidarrConnectionSettings`                                                           | `packages/rfmedia-cli/src/lib/lidarr/types.ts:83-112`                           | Keep frozen, canonical per-instance connection state.                                                       |
| `getLidarrConnectionApiKey`                                                                | `types.ts:123-135`                                                              | Keep exact-origin credential confinement.                                                                   |
| `StaticLidarrApiKeyProvider`                                                               | `types.ts:175-198`                                                              | Keep delayed validation/retrieval; never copy the key into generated configuration.                         |
| `sanitizeMessage`, `composeAbortSignals`, `readBoundedBody`                                | `client.ts:148-160`, `client.ts:248-314`                                        | Extract behavior into `transport.ts`; private implementation names may remain.                              |
| `isLidarrSystemStatus`, `isLidarrArtistArray`, `isLidarrWantedPage`, `isLidarrHealthArray` | `types.ts:252-261`, `types.ts:288-311`, `types.ts:351-361`, `types.ts:370-388`  | Retain as strict runtime projection gates after generated parsing.                                          |
| `LidarrError` hierarchy                                                                    | `packages/rfmedia-cli/src/lib/lidarr/errors.ts:25-202`                          | Keep authoritative and generator-agnostic.                                                                  |
| `classifyLidarrStatus`, `parseRetryAfter`                                                  | `errors.ts:204-270`                                                             | Reuse for bounded HTTP error responses.                                                                     |
| `createLidarrClient`, `resolveRequiredLidarrClient`                                        | `packages/rfmedia-cli/src/lib/lidarr/index.ts:97-124`                           | Keep public behavior; continue constructing isolated clients.                                               |
| `createLidarrClientMock`                                                                   | `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts:15-41`    | Keep action tests independent of generated code.                                                            |
| `auditPlexBoundaries` scanner helpers                                                      | `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs:58-101`, `:109-190` | Extend the existing scanner with the new owner/import rules; do not add another architecture framework.     |

The expected generated operation exports are `getApiV1SystemStatus`, `getApiV1Health`,
`getApiV1Artist`, and `getApiV1WantedMissing`. These names come from the pinned-spec/generator
research, not current repository code; implementation must assert them in a generated-contract test
before coupling `client.ts` to them.

## Test Patterns

### Transport and facade tests

- Keep Vitest colocated with TypeScript production modules. `client.test.ts` imports Node built-ins
  first, then Vitest, then relative `.js` modules (`packages/rfmedia-cli/src/lib/lidarr/client.test.ts:1-13`).
- Reuse the typed `FetchImplementation`, `createClient()`, `jsonResponse()`, and `asLidarrError()`
  helpers at `client.test.ts:15-42`. Split transport-only assertions into `transport.test.ts`, while
  keeping generated operation selection, wanted defaults, result unwrapping, projection, and stable
  error translation in `client.test.ts`.
- Retain the existing table-driven patterns: unsafe paths at `client.test.ts:104-121`, HTTP taxonomy
  at `client.test.ts:212-237`, and four guard failures at `client.test.ts:340-356`. Use `it.each` for
  repeated auth/query/header and malformed-projection matrices rather than duplicating setup.
- Existing endpoint tests at `client.test.ts:286-357` are parity evidence, but their URL assertions
  must now prove that generated operations own the paths/query serialization. Do not replace them
  with mocks of the generated functions; inject Fetch and observe the actual final request.
- Existing timeout/caller-abort cases at `client.test.ts:359-394` remain required. Add timeout while
  consuming a stalled body, because a timeout that stops after response headers does not protect the
  generated parser.

Add focused adversarial cases not covered by the current baseline:

1. Create two clients with different origins and keys, interleave/concurrently invoke both, and
   assert every final URL/header stays with its originating client.
2. Reject a generated request that already contains `X-Api-Key`, `Authorization`, query `apikey`, a
   credential-like query key, or the actual key as a query value before key retrieval and Fetch.
3. Reject a final URL with a different origin, embedded credentials, or a non-HTTP(S) scheme.
4. Assert `redirect: "error"` on the actual generated request and map redirect rejection without
   leaking URL/header secrets.
5. Bound chunked bodies regardless of `Content-Length`; include missing, understated, invalid, and
   oversized lengths. Assert the reader is cancelled on overflow.
6. Cover invalid UTF-8, malformed JSON, empty/incorrect generated result envelopes, invalid enums,
   non-finite numbers, malformed nested records, and oversized success/error bodies.
7. Preserve the caller abort reason, distinguish timeout from caller cancellation, and keep the
   timeout active through body reading and reconstructed-response creation.
8. Inspect client, generated client where reachable, thrown errors, logs, URLs, and serialized state
   to prove the key and raw error body never appear.

### Higher-layer parity

- Do not rewrite action tests. They already use a typed four-method mock
  (`lidarr-client-mocks.ts:15-41`) and cover tier, projection, filtering/paging, override forwarding,
  and error propagation across `packages/rfmedia-cli/src/actions/lidarr/*.test.ts`.
- Run command tests unchanged. They lock the four-command hierarchy, machine envelopes, option
  forwarding/defaults, text behavior, and exit/error handling at
  `packages/rfmedia-cli/src/commands/lidarr.test.ts:132-374`.
- Run tier and connection/error suites unchanged. `tiers.test.ts` proves the reliability semantics;
  `index.test.ts` protects configuration resolution; `errors.test.ts` protects classification and
  retry metadata.
- Run the three completion assertions unchanged at
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts:102-137`. They prove the Bash,
  Zsh, and Fish command trees still contain exactly `status`, `list`, `wanted`, and `health`; no
  completion source edit is warranted because issue #194 adds no command, flag, or enum.

### Generated and script contracts

- Add a generated-contract Vitest that imports the four expected named operations and representative
  generated models with `.js` specifiers, constructs two generated client instances with different
  custom Fetch functions, and exercises at least one request under Node 22. This catches naming,
  NodeNext, runtime-import, injected-Fetch, and instance-isolation regressions.
- Test generation/refresh scripts with `node:test`, matching the architecture script at
  `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs:1-35`. Use `mkdtempSync`, create
  minimal fixtures, assert structured failures, and always remove the fixture in `finally`.
- Script tests must cover byte-identical repeat generation, changed/missing/extra files, symlink and
  non-file entries, snapshot/config/manifest drift, path confinement, failed-generation preservation
  of the prior tracked tree, local-reference validation, immutable-ref refresh validation, and a
  check mode that leaves `git status --short` unchanged.

## Script and CI Patterns

- `rfmedia` is an ESM package (`packages/rfmedia-cli/package.json:2-6`), so scripts should be `.mjs`
  and use `node:` built-ins and `import.meta.dirname`/`fileURLToPath`, as the architecture script does
  at `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs:1-10`.
- Add composable workspace scripts such as `codegen:lidarr`, `codegen:lidarr:check`, and
  `openapi:lidarr:refresh` beside the current architecture scripts at
  `packages/rfmedia-cli/package.json:10-26`. The first two use only checked-in inputs; only refresh
  may access the network.
- Write mode should generate into a fresh package-local temporary directory, validate the completed
  tree, and only then replace `src/lib/lidarr/generated/`. Check mode should generate into a fresh
  temporary directory and compare sorted relative entry names, entry types, and file bytes against
  the committed tree. It must report changed/missing/extra/symlink entries plus the exact repair
  command and never mutate the tracked tree.
- Resolve all script paths relative to the script/package location, not the caller's current working
  directory. Validate the final output path is exactly the expected generated directory before any
  replacement. Do not follow symlinks during comparison or replacement.
- Keep the complete snapshot at `packages/rfmedia-cli/openapi/lidarr-v1.json`, an immutable manifest
  beside it, one checked-in `openapi-ts.config.mjs`, and generated output under
  `src/lib/lidarr/generated/`. Manifest fields must contain the allowlisted repository/path, full
  commit, commit-pinned URL, Git blob SHA, exact-byte SHA-256, exact generator/runtime versions, and
  config version, with no timestamps or machine paths.
- Pin the generator/runtime exactly in `devDependencies` and the root lockfile. The current package
  declares Node `>=22.0.0` at `packages/rfmedia-cli/package.json:28-30`; the candidate generator must
  run on that floor, not merely on the newest Node 22 patch.
- Normal install, typecheck, test, build, and pack consume committed output. Never put upstream
  refresh in `prebuild`, `pretypecheck`, `prepare`, or `postinstall`. The current pre-gates are
  `prebuild` and `pretypecheck` at `packages/rfmedia-cli/package.json:12-25`; add only the offline
  drift/architecture checks there.
- Add an explicit offline drift step after `npm ci` and before typecheck/tests in
  `.github/workflows/rfmedia-cli.yml:40-50`. CI already pins Node major 22 at workflow lines 34-41;
  add a separate Node-22.0 generation smoke if the declared minimum remains `22.0.0`, because
  `node-version: 22` alone resolves a current patch and does not prove the floor.
- Validate with the existing package gates: architecture tests, typecheck, coverage, build, and root
  formatting/markdown checks. Also run `npm pack --dry-run --workspace packages/rfmedia-cli` and
  inspect the actual file list/size so the full snapshot/generated tree and GPL attribution treatment
  are deliberate. There is currently no package `files` allowlist or `.npmignore`; package contents
  therefore need explicit evidence before any future publish.

There is no in-repository OpenAPI/codegen precedent (`rg` finds no current `openapi`, `codegen`, or
generated-client implementation outside this issue's research). Do not imitate unrelated generated
plans or add a general-purpose codegen framework. The tested Node script pattern is sufficient.

## Conventions

- TypeScript is strict NodeNext/ES2023 with `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`, `isolatedModules`, and `verbatimModuleSyntax` at
  `packages/rfmedia-cli/tsconfig.json:3-25`. Generated relative imports must include `.js`, and
  handwritten code must use `import type` for type-only dependencies.
- Follow the repository import grouping visible at `client.test.ts:1-13`: Node built-ins, blank line,
  third-party modules, blank line, local modules. Production imports are relative `.js` specifiers,
  as shown in `packages/rfmedia-cli/src/lib/lidarr/index.ts:11-17`.
- Vitest discovers colocated `src/**/*.test.ts` and `src/**/*.spec.ts` in a Node environment
  (`packages/rfmedia-cli/vitest.config.ts:3-15`). Standalone `.mjs` script tests use `node:test` and
  are invoked by an explicit package script.
- Repository formatting is two spaces, double quotes, semicolons, trailing commas, LF, and a
  100-column TypeScript / 120-column Markdown limit (`.prettierrc:1-43`). If generated output is
  formatted, use the lockfile-resolved repository Prettier consistently; do not manually format
  individual generated files.
- Preserve public action/domain names and the error code/retryability contract. Generated model and
  operation naming is private and may change only through a reviewed regeneration.
- Keep maintenance output concise and deterministic: one-line success with pinned commit, tool
  version, and file count; failure lists sorted relative paths and an exact repair command. Never log
  absolute machine paths, API keys, raw bodies, or nondeterministic timestamps in tracked artifacts.
- Update `ROADMAP.md` only when the complete #194 implementation is shipped; do not mark later Lidarr
  issues complete. No completion templates change unless a separate command-surface change occurs.

## Anti-Patterns

- Do not add TsArr as a runtime dependency. Its declared Node floor excludes the supported minimum,
  and its shared generated client failed two-instance isolation.
- Do not retain `LidarrRequest`, public `request<T>()`, path literals, HTTP verbs, or generic query
  serialization in handwritten production code; that would preserve the duplicate endpoint layer
  issue #194 is meant to remove.
- Do not let actions, commands, fixtures, `src/types/index.ts`, or `transport.ts` import
  `lib/lidarr/generated/*`. Only `client.ts` may couple to generated operations/models.
- Do not store the API key in generated client configuration, default headers, global auth state,
  interceptors, URLs, query strings, reflected objects, errors, logs, or `cause` chains.
- Do not trust generated TypeScript models as runtime validation or return broad optional wire models
  directly to actions.
- Do not permit generated/caller headers, auth parameters, redirects, or base URLs to override the
  hardened transport policy. Validate the final `Request`, not merely the facade's initial inputs.
- Do not return the original unbounded `Response` to the generated parser. Bound while streaming,
  fatal-decode, and reconstruct a safe response before generated parsing; keep timeout/cancellation
  active for this entire phase.
- Do not use `Content-Length` as the body-limit enforcement mechanism. It is only a possible early
  rejection hint; streamed byte count is authoritative.
- Do not configure query-key authentication even though the upstream spec advertises it. Runtime
  policy is header-only `X-Api-Key`.
- Do not generate from a mutable branch URL during install/build/test/CI, run refresh implicitly, or
  make normal development depend on GitHub/a live Lidarr server.
- Do not regenerate in place for check mode or use only `git diff --exit-code`; that can mutate the
  tree and miss entry-type/symlink concerns. Compare complete fresh trees by sorted path/type/bytes.
- Do not hand-edit, selectively format, or filter the generated tree. Filtering requires a later
  measured justification and a deterministic declarative configuration, never a hand-maintained
  four-operation spec fork.
- Do not introduce a second `GeneratedLidarrGateway`, a general HTTP middleware framework, a service,
  persistence, an operator-facing codegen CLI command, or an architecture-lint dependency. Existing
  seams and native Node APIs are sufficient.
- Do not change actions, command output/help, reliability tiers, or completion templates to
  accommodate generator envelopes; unwrap and project once in `client.ts`.

## Recommended Reuse

1. Preserve `LidarrClientApi`, `LidarrWantedQuery`, domain projections, resolver construction,
   action mocks, errors, and tiers exactly at their existing public boundaries.
2. First spike exact `@hey-api/openapi-ts@0.93.0` output against the pinned full snapshot. Record
   generated/runtime versions, `.js` NodeNext imports, exact four operation exports, custom Fetch and
   caller-signal call shapes, result/error envelope behavior, Node 22.0 import/request smoke, output
   determinism, redirect default, and two-instance isolation. Pin the runtime package exactly too.
3. Add snapshot, manifest, config, write/check/refresh scripts, and the full committed generated tree.
   Reuse the architecture script's native-Node/temp-fixture style, but implement a complete
   path/type/byte drift comparator with safe replacement.
4. Extract the existing secure request mechanics into one
   `createHardenedLidarrFetch()` closure in `transport.ts`. Preserve the `WeakMap` credential source,
   final-origin/auth rejection, exact header injection, redirects, delay, abort/timeout, streaming
   caps, fatal decoding, redaction, and existing `LidarrError` mapping.
5. Create one generated client per `LidarrClient`; call the four named generated operations and keep
   only defaults, unwrapping, strict projection, and error translation in `client.ts`. Delete the
   generic handwritten request interface/primitive after equivalent transport tests exist.
6. Extend `check-direct-plex-imports.mjs`: move the sole Lidarr Fetch owner from `client.ts` to
   `transport.ts`, keep the exactly-one-site rule, and add a rule that only `client.ts` imports the
   generated tree. Add fixture tests plus the real-tree assertion before relying on the gate.
7. Prove compatibility with focused generated/transport/client tests, unchanged action/command/error/
   tier/completion suites, offline drift, Node 22 floor smoke, typecheck, coverage, build,
   architecture, formatting, and pack inspection. Keep upstream refresh and any future publish as
   explicit separately authorized operations.
