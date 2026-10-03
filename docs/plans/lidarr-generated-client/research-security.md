## Executive Summary

The local-generation design is acceptable only if generated operations remain behind a handwritten,
per-instance security transport. The generator may own endpoint paths, query serialization, and wire
types; it must not own trust decisions. The existing Lidarr client already provides the correct
baseline: canonical HTTP(S) origin validation, an off-object origin-bound API key, header-only
authentication, rejected redirects, caller cancellation plus a hard timeout, bounded success and
error bodies, strict UTF-8 JSON, focused runtime validation, and redacted typed errors.

Two conditions are hard stops for issue #194:

1. The API key must never be stored in generated-client configuration or a generated header/auth
   object. The generated client must be instance-scoped and private, while the injected transport
   validates the final request URL, obtains the key from the origin-bound provider, injects only
   `X-Api-Key`, and forces `redirect: "error"` immediately before the trusted network fetch.
2. The generated Fetch runtime must never parse an unbounded response. The injected transport must
   consume and cap the decoded success and error streams, validate strict UTF-8, and return a bounded
   reconstructed `Response` (or a fixed typed failure) before generated code calls `json()` or
   `text()`.

This matters because the inspected `@hey-api/client-fetch@0.13.1` source defaults to
`redirect: "follow"`, constructs a `Request` containing configured headers, eagerly calls
`response[parseAs]()` for success bodies, and eagerly calls `response.text()` for error bodies. It
does support an injected Fetch implementation and per-instance `createClient`, so the risks can be
contained without restoring handwritten endpoint wrappers. TypeScript declarations are not runtime
validation; the adapter must continue to treat response data as untrusted and project only validated
fields into the stable rfmedia types.

The checked-in specification creates a separate release-compliance question. Lidarr's official
[OpenAPI document](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json)
labels itself `GPL-3.0`, while `packages/rfmedia-cli/package.json` declares MIT and the package has no
checked-in license/notice file or explicit npm publication allowlist. This is not legal advice, but
the project must document an approved treatment for the vendored specification and generated output
before publishing a package that contains them.

## Findings by Severity

### CRITICAL — Hard Stops

- **SEC-194-01 — Generated defaults would regress credential isolation and request confinement.**
  Never use generated query authentication, default redirect behavior, a module-global client, or a
  generated config/header object containing the API key. Use one private generated client per
  `LidarrClient`; inject a hardened fetch closure; validate the final URL against the captured origin;
  reject credential-like query keys and caller-supplied auth headers; then retrieve and inject
  `X-Api-Key`. Reconstruct the outgoing `Request` with `redirect: "error"`. Add concurrent two-client
  tests proving that neither origins nor keys cross.
- **SEC-194-02 — Generated eager parsing would remove response and timeout limits.** The inspected
  Fetch client reads successful and failed bodies without a size limit. The injected transport must
  stream at most the configured decoded-byte cap, cancel the reader on overflow, keep timeout/caller
  abort active through the read, reject invalid UTF-8, and return only a bounded reconstructed
  response. Test oversized chunked success and error bodies, misleading `Content-Length`, compressed
  expansion, stalled reads, and abort during body consumption.

### WARNING — Must Address

- **SEC-194-03 — Generated TypeScript models do not validate runtime values.** Preserve focused
  validators/projectors for every field consumed by status, health, list, and wanted. Accept
  generated data as `unknown` at the validation boundary; reject missing fields, wrong types,
  non-finite numbers, invalid health enums, malformed arrays, and malformed nested records as
  `invalid-response`.
- **SEC-194-04 — Generated result/error envelopes can retain secrets and untrusted bodies.** A
  generated result may contain a `Request` with `X-Api-Key`, a raw `Response`, and a parsed error
  body. Keep the generated client/result private, unwrap immediately, and never log, serialize,
  return, or attach those objects as `Error.cause`. Map failures using fixed messages plus safe status
  metadata only. Preserve caller abort reason identity, but do not preserve arbitrary network or
  response-body causes.
- **SEC-194-05 — The upstream spec is untrusted code-generation input.** The refresh script must
  download only from the allowlisted `Lidarr/Lidarr` repository, exact path, and resolved immutable
  commit; enforce a download-size cap; parse JSON; reject all non-local `$ref` values; validate the
  OpenAPI version, required operations, and both documented security schemes; and write only after
  all checks pass. External references could otherwise make nominally local generation perform
  unexpected network access.
- **SEC-194-06 — Provenance and drift checks can give false assurance if they compare too little.**
  The manifest must include a schema version, full upstream commit, path, Git blob SHA, exact-byte
  SHA-256, exact generator and runtime-client versions, and config version. Verify the manifest
  before generation. Generate into a fresh temporary directory and recursively compare file names,
  types, and bytes, detecting missing, modified, extra, and symlink entries; `git diff` alone misses
  untracked files. Normal CI must be network-independent and must not modify the checkout.
- **SEC-194-07 — Codegen expands the npm supply chain.** Pin `@hey-api/openapi-ts` exactly as a dev
  dependency and pin the generated runtime client and any validator package exactly as production
  dependencies; commit lockfile integrity data; use `npm ci`; never use unversioned `npx`; and review
  lockfile plus generated diffs on upgrades. Keep plugins/config local and fixed. Treat generator
  execution as arbitrary build-time code even though its output is committed.
- **SEC-194-08 — The GPL-described snapshot needs an explicit publication decision.** Retain upstream
  provenance and license attribution, add a third-party notice or equivalent approved record, and
  have the maintainer determine whether the spec and generated output may be shipped under the
  package's current MIT metadata. Verify the actual tarball with `npm pack --dry-run`; today the
  package lacks an npm `files` allowlist and falls back to `.gitignore`, so a future `openapi/`
  directory would normally be publishable. Do not publish until this is resolved.
- **SEC-194-09 — Destructive generation must be path-confined.** Before cleaning output, resolve the
  package root and generated destination, reject symlinks, and prove the destination is exactly the
  expected child directory. Never accept output paths from the spec, manifest, CLI passthrough, or
  environment. Atomic replacement should occur only after successful generation and validation.
- **SEC-194-10 — A privileged refresh bot could turn upstream input into repository code.** Any
  scheduled/manual refresh workflow must use minimal permissions, pinned action SHAs, no fork
  secrets, and a dedicated reviewed PR. Do not use `pull_request_target` to generate or execute code
  from an untrusted checkout, and do not auto-merge spec/generated diffs.

### ADVISORY — Best Practices

- Prefer HTTPS for non-loopback Lidarr origins and document that plain HTTP exposes the API key and
  response data to the network. Do not ban localhost or private-network HTTP without a separate
  compatibility decision; local self-hosting is the expected deployment.
- Keep generated modules out of public barrels. Extend the architecture check so only the Lidarr
  adapter imports `lib/lidarr/generated/`, and so the secure transport remains the only authenticated
  network owner.
- Generate only the four required read operations if the pinned generator offers deterministic,
  supported filtering. Otherwise a full private SDK is acceptable when architecture tests make
  mutating operations unreachable from application code.
- Run dependency review and vulnerability scanning on codegen dependency changes, and record an
  SBOM/provenance artifact for releases where practical. These supplement, not replace, exact pins
  and code review.
- Add an optional live Lidarr contract job against a pinned container release. Keep it separate from
  deterministic mocked tests and ordinary offline CI.

## Authentication and Authorization

The official spec declares two alternative global schemes: `X-Api-Key` in a header and `apikey` in
the query string. The runtime must select neither generated scheme. Query credentials are explicitly
forbidden because URLs are routinely captured by access logs, proxies, telemetry, histories, and
error output.

The secure request sequence should be:

1. A private generated operation creates a request without credentials.
2. The injected transport parses the final `Request.url` and requires HTTP(S), exact canonical
   origin equality, no username/password/fragment, and no authentication-like query key.
3. The transport rejects pre-existing `X-Api-Key`, `Authorization`, cookie, token, or proxy-auth
   headers rather than allowing generated/caller values to override policy.
4. Only after URL validation, the transport asks the `LidarrApiKeyProvider` for the credential bound
   to that same origin and rejects a query value equal to the key.
5. It clones the request with the required `Accept` and `X-Api-Key` headers, the composed signal, and
   `redirect: "error"`, then calls the trusted underlying fetch implementation.

Do not place the key in `createClient({ headers })`, generated auth configuration, interceptors,
operation options, or an object returned by `getConfig()`. Preserve the current private-field and
`WeakMap` model so reflection, object spread, inspection, and JSON serialization do not expose it.
An injected fetch is inherently a credential-bearing capability; keep injection an internal/test
constructor seam and do not expose it to config files or plugins.

Use `createClient` per Lidarr adapter instance and pass that instance explicitly to generated
operations. Do not import or configure any generated singleton. A concurrency test must create two
clients with different origins and keys, invoke them in interleaved order, and assert exact
origin/key pairs at the final transport.

## Data Protection

Keep the existing 8 MiB success and 4 KiB error caps unless product evidence justifies different
limits. Count bytes actually read after HTTP content decoding, not just `Content-Length`; an absent or
false header must not bypass the cap. Cancel the stream as soon as the cap is crossed. Error bodies
should be drained only up to the error cap and then discarded; their contents provide no trusted
diagnostic value.

Validate UTF-8 with `TextDecoder("utf-8", { fatal: true })` before reconstructed bodies reach the
generated parser. Never return raw response bodies, headers containing unexpected secrets, generated
request/response envelopes, or parser exceptions to actions. Safe error context is limited to the
stable operation label, numeric status, retryability, and validated `Retry-After` delta seconds.

The adapter should retain no response beyond normalization. Domain projections should contain only
the fields already exposed by `LidarrClientApi`; generated models and unknown upstream fields remain
private. Logging may include the configured canonical origin and operation, but never the full URL,
headers, API key, raw body, generated options, or generated result.

## Dependency Security

`@hey-api/openapi-ts@0.93.0` is MIT-licensed, declares Node `>=20.19.0`, and is compatible with the
project's Node 22 toolchain according to its published package metadata. The generator is a
development dependency, but its generated Fetch runtime is a production dependency and needs its
own exact pin. Confirm the exact pairing by generating once, inspecting imports, and recording both
versions in the manifest and lockfile.

The checked-in spec and generated output reduce availability risk but do not eliminate supply-chain
risk: `npm ci` and codegen still execute third-party code. Keep normal builds dependent only on
committed generated source, keep refresh separate, review package lifecycle scripts and lockfile
changes, and regenerate in a disposable directory. A generator upgrade is a security-sensitive
change requiring all transport, isolation, redaction, runtime-validation, and deterministic-drift
tests to pass.

## Input Validation

Validate three distinct inputs independently:

- **Configuration:** canonical HTTP(S) origin only; no credentials, path, query, or fragment; positive
  safe-integer timeout and body limits; non-empty control-character-free API key.
- **OpenAPI snapshot:** capped size, valid JSON/OpenAPI structure, local-only references, expected
  source identity, required read operations and response schemas, expected header/query security
  declarations, and digest/provenance match before generation.
- **Runtime responses:** strict UTF-8 and JSON; bounded bytes; exact arrays/records; finite numeric
  fields; required strings/booleans; known health enum; validated nested artist and wanted records.

Generated types may guide projectors but cannot be used as evidence that an `unknown` response is
valid. Avoid coercion, defaulting malformed required fields, or passing optional generated fields
directly into domain objects. Keep query defaults (`page=1`, `pageSize=50`,
`sortKey=releaseDate`) in the adapter, but let generated operations serialize them.

## Infrastructure Security

The existing rfmedia workflow already uses read-only contents permission, action commit-SHA pins,
and `persist-credentials: false`; preserve those controls. Add the offline codegen drift check before
typecheck/tests. The check must validate the manifest and snapshot, run generation only from the
local snapshot, and compare the complete temporary tree with committed output.

If upstream drift automation is added, isolate it in a scheduled/manual workflow. Resolve the most
recent commit for the allowlisted file, download the file from that exact SHA, verify the returned
blob/digest, and open a non-privileged review PR. Never generate from mutable `develop` in ordinary
CI. Never let upstream schema text choose a repository path, command, package name, plugin, template,
or network URL.

## Secure Coding Guidelines

- Keep security policy handwritten and endpoint identity generated.
- Acquire credentials only after validating the final generated URL.
- Make the generated client, its mutable configuration methods, interceptors, and result envelopes
  unreachable outside the adapter.
- Force redirect rejection at the final fetch boundary, not only in initial client options.
- Catch underlying fetch/parser failures before they can expose a credential-bearing `Request`; map
  them to fixed internal sentinels without raw causes.
- Compose caller cancellation with timeout and preserve the caller's exact abort reason. Distinguish
  timeout, body overflow, invalid response, HTTP classification, and network unreachability without
  embedding raw error text.
- Validate response content as `unknown`, then construct new domain objects. Do not return generated
  objects by reference.
- Treat generated output as replace-only. Review it, but never patch it manually.
- Validate real paths before recursive deletion or atomic replacement in generation scripts.
- Test architecture and security properties, not only successful generated calls.

Required regression tests include header-only auth, exact-origin enforcement, unsafe query/header
rejection, redirect rejection, reflected-state redaction, raw-envelope non-escape, two-instance
concurrency, caller abort identity, timeout during headers and body, bounded chunked success/error
bodies, strict UTF-8, malformed domain shapes, status/`Retry-After` mapping, required operation
existence, local-only spec references, manifest digest failure, deterministic generation, and
extra/missing generated-file detection.

## Trade-off Recommendations

- **Custom secure transport vs generated defaults:** use the custom transport. The small handwritten
  policy layer is necessary and does not violate the issue's prohibition on handwritten endpoint
  wrappers.
- **Focused validators vs generated validators:** retain focused projectors for the four public
  operations initially. Generated Zod/Valibot schemas add dependencies and output; adopt them only if
  they can preserve strictness, stable errors, exact pins, and body-first limits.
- **Filtered vs full SDK:** prefer a supported deterministic filter to the four read operations. If
  filtering is fragile or unsupported, commit the full SDK but keep it private and enforce imports;
  do not hand-edit generated files to remove operations.
- **Manual vs scheduled refresh:** begin with an explicit maintainer command. Add a bot only after
  permissions, licensing, review ownership, and non-auto-merge behavior are settled.
- **HTTP compatibility vs transport confidentiality:** retain HTTP for loopback/private self-hosting
  compatibility, recommend HTTPS for any routed/non-local origin, and do not silently upgrade or
  follow redirects.
- **Exact-byte vs semantic digest:** use exact normalized snapshot bytes for the required SHA-256 and
  record the upstream Git blob SHA. A canonical semantic digest may be added, but must not replace
  exact-byte reproducibility.

## Open Questions

- What approved attribution and package-license treatment applies to the GPL-3.0-labelled Lidarr
  specification and code generated from it? Is `rfmedia` intended to be published to npm in this
  form?
- Which exact `@hey-api/client-fetch` version is emitted/required by
  `@hey-api/openapi-ts@0.93.0`, and will both be pinned without ranges?
- Can the pinned generator filter deterministically to the four required read operations without
  relying on a manually maintained endpoint list or post-generation edits?
- Should non-loopback HTTP origins produce a warning, or should a future policy require HTTPS unless
  explicitly opted out?
- Is the existing 8 MiB success cap sufficient for the largest supported artist library, or does it
  need a documented configurable upper bound?
- Will upstream refresh remain manual, or who owns review and minimal-token permissions for a bot PR?
- Which Lidarr release range must the snapshot support, and should a pinned-container contract job
  cover the oldest supported release as well as current `develop`?
