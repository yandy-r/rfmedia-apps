# Architecture Analysis

## Executive Summary

Issue #194 is a replacement of one outbound integration boundary, not a new user-facing feature.
The command and action layers are already stable and should continue to depend on the four-method
`LidarrClientApi`. The architectural change is to split the current handwritten `client.ts`
monolith into three distinct owners:

1. a committed, private SDK generated from a complete immutable Lidarr OpenAPI snapshot;
2. a handwritten final-Fetch transport that owns all trust and resource policy; and
3. the existing handwritten facade, reduced to selecting named generated operations, supplying
   stable defaults, projecting untrusted wire values into domain objects, and translating failures.

The resulting runtime dependency direction is:

```text
commands -> actions -> LidarrClientApi facade -> generated operations -> hardened transport -> Lidarr API
```

Generated code becomes the only source of truth for endpoint paths, HTTP verbs, query
serialization, and complete wire DTOs. Handwritten code remains the only source of truth for
origin confinement, credentials, redirects, cancellation/timeouts, response limits, runtime
validation, domain projections, and the stable error taxonomy. Neither source of truth may absorb
the other's responsibilities.

The local-generation decision is fixed by the compatibility evidence: `tsarr@2.12.0` declares Node
`>=24.16.0` while rfmedia-cli supports Node `>=22.0.0`, and TsArr's module-scoped generated client
failed two-instance origin/key isolation. Use the official Lidarr snapshot pinned to commit
`3e2858439ff35b372d0af00bcea1b0a357572d26` and exact `@hey-api/openapi-ts@0.93.0`, subject to the
implementation spike confirming the exact emitted Fetch runtime and call shape. Ordinary install,
build, typecheck, test, and PR CI must remain offline with respect to GitHub and Lidarr.

## Architecture Context

The shipped Layer-1 design has sound upper-layer seams but combines too many lower-layer concerns:

- `commands/lidarr.ts` declares the four commands, parses flags, lazily calls actions, and renders
  human or machine output (`packages/rfmedia-cli/src/commands/lidarr.ts:100-168`, `221-268`,
  `317-362`, `408-448`). This entire surface is outside the implementation boundary for #194.
- The actions resolve `LidarrClientApi` and consume stable domain values. Status performs two
  concurrent calls (`actions/lidarr/status.ts:94-110`), list fetches and locally filters artists
  (`actions/lidarr/list.ts:127-143`), wanted passes paging/sort inputs
  (`actions/lidarr/wanted.ts:83-104`), and health filters returned checks
  (`actions/lidarr/health.ts:43-60`). No action owns an endpoint or transport concern.
- `lib/lidarr/index.ts` resolves config/CLI overrides, canonicalizes a bare HTTP(S) origin, builds an
  origin-bound connection, and constructs the client (`lib/lidarr/index.ts:46-124`). This is already
  the correct composition root.
- `lib/lidarr/client.ts` exposes the stable four-method interface
  (`lib/lidarr/client.ts:72-116`) but also exposes the generic `LidarrRequest` escape hatch and its
  handwritten path/query contract (`lib/lidarr/client.ts:58-70`).
- The same client currently owns manual URL/query construction (`lib/lidarr/client.ts:210-246`),
  abort composition and bounded parsing (`lib/lidarr/client.ts:248-322`), native Fetch and HTTP
  classification (`lib/lidarr/client.ts:328-415`), and four handwritten paths
  (`lib/lidarr/client.ts:417-469`). This is the coupling #194 must remove.
- Credential storage is already correctly isolated. `createLidarrConnectionSettings` validates a
  canonical origin and binds the API key in a module-private `WeakMap`
  (`lib/lidarr/types.ts:70-135`); `StaticLidarrApiKeyProvider` validates the key without placing it
  on an enumerable object (`lib/lidarr/types.ts:149-198`).
- Focused runtime guards validate the exact fields consumed by the commands, including finite
  numbers, nested artist/wanted records, and the closed health enum
  (`lib/lidarr/types.ts:240-388`). The public types are deliberately narrow domain-shaped values,
  although their comments currently describe them as wire contracts (`src/types/lidarr.ts:23-160`).
- `errors.ts` defines the stable structured error shape (`lib/lidarr/errors.ts:25-80`) and owns
  `Retry-After` plus HTTP status classification (`lib/lidarr/errors.ts:204-270`). Generated error
  envelopes must not replace this boundary.
- The architecture scanner authorizes exactly one Lidarr Fetch owner in `client.ts`
  (`scripts/check-direct-plex-imports.mjs:11-29`, `94-190`), with fixture and real-tree coverage
  (`scripts/check-direct-plex-imports.test.mjs:99-125`). It does not yet enforce generated-import
  privacy.
- The package uses strict ES2023/NodeNext compilation with `isolatedModules` and
  `verbatimModuleSyntax` (`packages/rfmedia-cli/tsconfig.json:3-28`), declares Node `>=22.0.0`, and
  currently runs architecture checks before typecheck/build
  (`packages/rfmedia-cli/package.json:10-30`). CI uses Node 22, `npm ci`, typecheck, and coverage with
  read-only contents permission and a credential-free checkout (`.github/workflows/rfmedia-cli.yml:21-50`).
- Bash, Zsh, and Fish already assert the same four-command surface
  (`src/lib/shell-completions/templates.spec.ts:102-137`). Because no CLI surface changes, the
  templates must remain byte-identical.

## Target Architecture

```text
packages/rfmedia-cli/openapi/lidarr-v1.json
+ lidarr-v1.manifest.json
+ openapi-ts.config.mjs
+ exact package/lock versions
|
v
scripts/generate-lidarr-client.mjs
write mode | check mode
|
v
src/lib/lidarr/generated/* (private, replace-only)
^
|
commands -> actions -> index.ts -> client.ts
| one generated client per facade instance
| four named generated operation calls
| defaults, projections, error translation
v
transport.ts
| inspect final generated Request
| validate origin/auth policy
| acquire and inject key
| timeout/abort/body limits/strict UTF-8
v
native Node fetch
```

The target has the following exact boundaries:

| Concern                                 | Sole source of truth                                                                | Forbidden duplication                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Upstream API contract                   | Complete commit-pinned `openapi/lidarr-v1.json`                                     | Hand-edited four-path specs or live `develop` input in ordinary workflows                        |
| Provenance/tool inputs                  | Versioned `lidarr-v1.manifest.json`, fixed config, exact package versions, lockfile | Timestamps, machine paths, mutable refs, ranges, or unversioned `npx`                            |
| Paths, verbs, query encoding, wire DTOs | `src/lib/lidarr/generated/*`                                                        | Handwritten request paths, generic serializers, or copied wire interfaces                        |
| Runtime trust policy                    | `src/lib/lidarr/transport.ts`                                                       | Generated auth config, redirects, unbounded generated parsing, or a second Fetch owner           |
| Application API and defaults            | `src/lib/lidarr/client.ts` and `LidarrClientApi`                                    | Generated names/envelopes leaking into actions or commands                                       |
| Domain values                           | Fresh projections described by `src/types/lidarr.ts`                                | Returning generated objects by reference or trusting TypeScript types at runtime                 |
| Error contract                          | `lib/lidarr/errors.ts` plus facade/transport translation                            | Raw generator errors, bodies, `Request`, `Response`, or unsafe causes crossing the facade        |
| Connection/credential binding           | `lib/lidarr/types.ts` private connection/provider machinery                         | API keys in generated headers, auth state, options, interceptors, logs, or public config objects |
| Generated-tree ownership                | Generation/check scripts                                                            | Manual edits, partial in-place repair, or upper-layer imports                                    |

`client.ts` is the only handwritten production module allowed to import generated modules. It
creates a private generated client for each `LidarrClient` instance and passes that client explicitly
to every named operation; generated singletons or module-global configuration are prohibited.
`transport.ts` is the only authenticated Lidarr Fetch owner. It implements the Fetch signature the
generated runtime expects but does not own operation names or endpoint paths. The `lib/lidarr/index.ts`
barrel may continue exporting client/errors/tiers, but must never export `generated/*`.

The public interfaces remain source-compatible:

- `getSystemStatus(signal?)`
- `getHealth(signal?)`
- `listArtists(signal?)`
- `getWantedMissing(query?)`

The public generic `request()` method and `LidarrRequest` type must be removed. Retaining them would
leave a supported path for future handwritten endpoints and defeat the ownership split.

## Critical Files

### Existing files to change

| File and verified current range                                          | Architectural responsibility after #194                                                                                                                                                                              |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/lidarr/client.ts:38-116`                   | Retain constants, dependency seams, `LidarrWantedQuery`, and `LidarrClientApi`; remove `LidarrRequest`.                                                                                                              |
| `packages/rfmedia-cli/src/lib/lidarr/client.ts:210-547`                  | Reduce to per-instance generated-client composition, four named operations, fresh projections, and safe generated-result/error translation; move final-Fetch policy out and delete manual endpoint/request assembly. |
| `packages/rfmedia-cli/src/lib/lidarr/types.ts:70-198`                    | Retain frozen connection state, private `WeakMap`, origin-bound key lookup, and provider validation.                                                                                                                 |
| `packages/rfmedia-cli/src/lib/lidarr/types.ts:200-388`                   | Retain the validation semantics, but reshape guards into focused `unknown`-to-domain projectors that construct new values instead of returning generated objects. Remove generic handwritten query/wire ownership.   |
| `packages/rfmedia-cli/src/types/lidarr.ts:23-160`                        | Keep stable action-facing projections; revise wire-contract comments and do not import/re-export generated models.                                                                                                   |
| `packages/rfmedia-cli/src/lib/lidarr/errors.ts:25-270`                   | Preserve error codes, retryability, safe status context, and `Retry-After`; generated/runtime failures are translated into this taxonomy.                                                                            |
| `packages/rfmedia-cli/src/lib/lidarr/index.ts:46-124`                    | Remain the config-to-client composition root; no generated imports or credential placement in generated configuration.                                                                                               |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs:11-218`      | Generalize authenticated network-boundary reporting, move the Lidarr owner to `transport.ts`, and enforce that only `client.ts` imports `generated/*`.                                                               |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs:99-125` | Replace the old client-fetch fixtures and add generated-import allow/deny fixtures plus real-tree coverage.                                                                                                          |
| `packages/rfmedia-cli/package.json:10-30,68-80`                          | Add write/check/refresh scripts, wire offline drift into validation, and exact-pin the generator/runtime pair without changing the Node floor silently.                                                              |
| `package-lock.json`                                                      | Lock the complete exact dependency graph and integrity data.                                                                                                                                                         |
| `.github/workflows/rfmedia-cli.yml:21-50`                                | Add an explicit offline codegen drift step before typecheck/tests while retaining existing least-privilege controls.                                                                                                 |
| `ROADMAP.md:210-224,341-362,381-389`                                     | Mark only #194 shipped after all gates pass; leave #195, #196, and later Lidarr work open.                                                                                                                           |

The existing command, action, mock, output, and shell-template production files are compatibility
boundaries, not expected edit targets. Their existing tests should be rerun unchanged.

### New owned artifacts

| File or directory                                                | Ownership                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/openapi/lidarr-v1.json`                    | Exact-byte complete upstream snapshot pinned to the approved immutable Lidarr commit.                                                             |
| `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`           | Schema version, repository, full commit, source path/URL, Git blob SHA, exact-byte SHA-256, exact generator/runtime versions, and config version. |
| `packages/rfmedia-cli/openapi-ts.config.mjs`                     | One local-input Fetch SDK job with NodeNext `.js` imports and a fixed output path.                                                                |
| `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`        | Manifest validation, local generation, required-contract assertion, atomic write mode, and non-mutating full-tree check mode.                     |
| `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.mjs`        | Explicit networked immutable-ref refresh with allowlisted source, capped input, local-only refs, validation, provenance update, and regeneration. |
| `packages/rfmedia-cli/src/lib/lidarr/generated/*`                | Complete committed machine-owned SDK/runtime/types; private and replace-only.                                                                     |
| `packages/rfmedia-cli/src/lib/lidarr/transport.ts`               | Generated-client-compatible secure Fetch closure and bounded reconstructed responses.                                                             |
| `packages/rfmedia-cli/src/lib/lidarr/transport.test.ts`          | Final-origin/auth, redirect, body, timeout, cancellation, isolation, and redaction contracts.                                                     |
| `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts` | NodeNext import, instance isolation, required named operations/models, and generated call-shape contract.                                         |
| Generator/refresh script tests                                   | Provenance, digest, path confinement, determinism, check-mode immutability, and changed/missing/extra/symlink detection.                          |

## Data and Control Flow

### Runtime success path

1. A Commander leaf parses the unchanged flags and invokes its existing action.
2. The action calls `resolveRequiredLidarrClient`, which combines CLI overrides and loaded config,
   canonicalizes the bare origin, and creates a frozen connection with an off-object credential.
3. The facade method supplies only stable operation inputs. For wanted/missing, it preserves
   `page=1`, `pageSize=50`, `sortKey=releaseDate`, and omits an unset `sortDirection`; it must not
   begin sending `includeArtist`, `monitored`, or other generated options.
4. A named generated operation owns the path, method, and serialization and receives the private
   generated client plus caller signal.
5. The generated runtime calls the injected transport. The transport materializes and validates the
   final URL/headers before any credential is retrieved.
6. Only after validation, the transport asks the origin-bound provider for the key, reconstructs the
   request with exactly one `X-Api-Key`, `Accept: application/json`, the composed signal, and
   `redirect: "error"`, then calls the trusted native Fetch implementation.
7. The transport keeps caller cancellation and the hard timeout active through body consumption,
   streams and caps decoded bytes, rejects invalid UTF-8, and returns a new bounded `Response` to the
   generated parser. Success remains capped at 8 MiB and error content at 4 KiB.
8. `client.ts` immediately unwraps the private generated result, treats its data as `unknown`, and
   constructs a new `LidarrSystemStatus`, health list, artist list, or `LidarrWantedPage` through
   focused projectors.
9. The action receives the same direct domain value as today and performs its unchanged projection;
   no generated type, option, envelope, request, or response crosses the facade.

### Runtime failure path

The transport and facade translate at their respective trust boundaries. Unsafe URL/header/query,
provider failure, redirect, timeout, caller abort, body overflow, invalid UTF-8/JSON, HTTP status,
and malformed domain shape must emerge through the current `LidarrError` taxonomy or the caller's
original abort reason. Only operation label, numeric status, retryability, and validated
`Retry-After` delta seconds are safe metadata. Raw response content, generated request/response
envelopes, headers, URLs, parser/network messages, and credential-bearing causes must be discarded.

### Code generation and drift path

1. `codegen:lidarr` validates the fixed manifest against the local snapshot and exact installed
   versions, generates into a fresh temporary directory, validates the required operations/models,
   and atomically replaces only `src/lib/lidarr/generated/` after success.
2. `codegen:lidarr:check` performs the same local generation in a temporary directory, then compares
   sorted relative entries, entry types, and bytes against the committed tree. It detects changed,
   missing, extra, and symlink entries and never changes the checkout.
3. `openapi:lidarr:refresh -- --ref <immutable-ref>` is the only networked path. It resolves and
   downloads only the allowlisted `Lidarr/Lidarr` repository path at an immutable commit, validates
   and records provenance, regenerates, and leaves a reviewable snapshot/generated diff.
4. PR CI uses only the checked-in snapshot and lockfile. It runs drift before typecheck/tests, so a
   generator/config/snapshot mismatch fails early without depending on upstream availability.

## Constraints and Invariants

### Security invariants

- The generated client is per `LidarrClient` instance. No generated singleton, shared mutable base
  URL, shared headers, interceptor state, or global configuration is allowed.
- The API key exists only in the private provider binding and the final transport call. It is never
  stored in generated config/auth/header objects or returned generated envelopes.
- Before key acquisition or network access, the transport requires HTTP(S), exact canonical-origin
  equality, no username/password/fragment, no authentication-like query key/value, and no
  pre-existing `X-Api-Key`, `Authorization`, cookie, proxy-auth, or token header.
- Redirects are rejected at the final Fetch boundary, not merely requested in higher-level client
  configuration.
- Generated code never parses an unbounded body. The transport counts bytes actually read after HTTP
  decoding, ignores misleading or absent `Content-Length`, cancels on overflow, and preserves
  timeout/caller abort through streaming.
- UTF-8 decoding is fatal. Generated compile-time models are never treated as runtime validation.
- Projectors reject missing/wrong required fields, non-finite numbers, invalid health enums,
  malformed arrays, and malformed nested records, and construct fresh domain objects.
- Generated requests, raw responses/bodies, generated errors/options, and unsanitized causes never
  leave `client.ts` or appear in logs, JSON, error messages, reflection, or serialization.
- Generator output replacement is path-confined to the exact resolved generated directory, rejects
  symlink traversal, and occurs only after successful generation and validation.
- Snapshot refresh caps input, rejects non-local `$ref` values, validates required operations and
  both declared security schemes, and never lets schema/config/environment data choose output paths,
  plugins, commands, packages, or network destinations.

### Generated/manual ownership invariants

- Generated code exclusively owns paths, verbs, parameter names/serialization, full response DTOs,
  and generated client plumbing.
- Handwritten code exclusively owns the stable facade, operation labels/defaults, trust policy,
  runtime projections, and stable error semantics.
- Only `client.ts` may import `generated/*`; only `transport.ts` may call native Fetch for Lidarr;
  public barrels, actions, commands, and tests outside the generated contract layer may not depend on
  generated names.
- Generated files are committed, carry a machine-owned marker, and are replace-only. Formatting or
  post-processing must be deterministic and part of the fixed generation path.
- The complete upstream snapshot and full private SDK are the initial scope. Filtering is not added
  until measured tracked/packed/build/startup cost justifies a deterministic fail-closed filter.

### NodeNext and toolchain invariants

- Preserve the declared Node runtime floor of `>=22.0.0`; do not silently require Node 22.18+ or
  Node 24 through development tooling.
- Exact-pin `@hey-api/openapi-ts@0.93.0`. Discover the emitted/required
  `@hey-api/client-fetch` version in the spike, then pin that runtime exactly and record both versions
  in the manifest and lockfile. The inspected `0.13.1` behavior is a threat model, not permission to
  assume the final pairing.
- Generated TypeScript must compile under the existing ES2023/NodeNext strict configuration and use
  `.js` on relative import specifiers. The generator config must point to the real package
  `tsconfig.json`; no Bun runtime or Bun type dependency is permitted.
- Because the upstream spec has no `operationId` values, derived names such as
  `getApiV1SystemStatus`, `getApiV1Health`, `getApiV1Artist`, and
  `getApiV1WantedMissing` are generator-version-sensitive and require compile/runtime contract tests.
- Generation inputs are exactly the snapshot, manifest, config, exact generator/runtime versions,
  lockfile, and deterministic formatter version. Generated bytes contain no timestamps, absolute
  paths, hosts, usernames, or other machine state.
- Do not use caret ranges, mutable refs, live-schema generation, or unversioned `npx`. Normal install,
  build, typecheck, test, pack, and CI remain network-independent after `npm ci`.
- Bash, Zsh, and Fish templates remain unchanged. Existing parity tests are the architectural proof
  that code generation did not leak into the operator CLI.
- Retain Lidarr source and GPL-3.0 attribution. The snapshot/generated-output treatment and packed
  npm contents require an explicit maintainer decision before publication; #194 itself performs no
  publish.

## Implementation Implications

The integration sequence must respect the runtime shape discovered from the exact generator pair:

1. Record the TsArr rejection and verify the exact Hey API generator/runtime pair under Node 22,
   including `.js` NodeNext imports, per-instance construction, injected Fetch, result shape,
   redirects, and required named operations.
2. Establish immutable inputs first: full snapshot, provenance manifest, fixed config, exact pins,
   lockfile, and deterministic write/check scripts. A generated-contract test becomes the executable
   boundary for all later work.
3. Extract existing security behavior into `transport.ts` against the confirmed generated Fetch
   signature before deleting it from `client.ts`. Prove origin/key isolation and bounded response
   reconstruction, including interleaved two-client requests and body-consumption timeouts.
4. Migrate the four facade methods one by one to named generated operations. Preserve operation
   labels, wanted defaults/omissions, direct domain returns, HTTP classification, abort identity, and
   focused strict projectors; then remove `request()` and `LidarrRequest`.
5. Generalize the architecture scanner only after final locations exist: one Lidarr Fetch in
   `transport.ts`, no other production Fetch owner, and generated imports only from `client.ts`.
6. Wire the offline drift check into package validation and CI, then run the unchanged index,
   errors, tiers, actions, commands, mocks, outputs, and all-shell completion tests as compatibility
   evidence.
7. Validate deterministic regeneration, typecheck, coverage, build, whitespace, and
   `npm pack --dry-run`; document generation/refresh/rollback/ownership/attribution; only then update
   `ROADMAP.md` to show #194 shipped.

No database migration, daemon, inbound API, new `rfmedia` command, completion installation change,
retry/circuit-breaker behavior, scheduler, mutation endpoint, or live-upstream dependency belongs in
this architecture. Those concerns remain with later Lidarr issues.

## Open Risks

- **Exact runtime pairing:** `@hey-api/openapi-ts@0.93.0` must be spiked to identify and exact-pin its
  emitted Fetch runtime. If it cannot emit valid `.js` NodeNext imports, construct isolated clients,
  accept the secure Fetch closure, or tolerate bounded reconstructed responses, use
  `openapi-typescript` plus `openapi-fetch` as the first fallback rather than weakening invariants.
- **Generated envelope semantics:** the exact success/error/throw behavior must be confirmed before
  final error translation is designed. No raw envelope or credential-bearing `Request` may cross the
  facade.
- **Wanted contract drift:** the emitted option type and serialized request must preserve only the
  current four query inputs and omission behavior. The upstream default page size differs from the
  CLI's explicit 50, and adding `includeArtist` or `monitored` would be a behavior change.
- **Bounded response reconstruction:** tests must prove that status/headers needed for classification
  survive reconstruction while oversize, chunked, misleading-length, compressed, invalid UTF-8,
  stalled, timeout, and caller-abort cases remain bounded and correctly classified.
- **Spec-to-deployment mismatch:** the approved immutable commit is reproducible but may not exactly
  match every deployed Lidarr version. Mocked/generated contract tests are required for #194; a
  separately owned live-container matrix may supplement them later.
- **Full SDK cost:** the complete spec is large and has derived operation names. Measure tracked and
  packed bytes, typecheck duration/memory, and cold help startup; do not introduce filtering until a
  recorded material regression exists.
- **Publication and license treatment:** the upstream snapshot identifies GPL-3.0 while the package
  declares MIT and currently has no explicit `files` allowlist. Attribution, notice, and packed-file
  policy must be approved before any future npm publish.
- **Body-size compatibility:** the existing 8 MiB success limit is the compatibility default but may
  be tight for exceptionally large artist libraries. Change it only with separate product evidence,
  not as an incidental codegen decision.
