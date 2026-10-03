## Executive Summary

Tsarr is a credible reference implementation, but it is not a safe direct runtime
dependency for `rfmedia-cli` today. The current npm release, `tsarr@2.12.0`, is an
ESM package with an explicit `node >=24.16.0` engine requirement, while
`rfmedia-cli` declares `node >=22.0.0` and its GitHub Actions workflow runs Node 22.
See the [Tsarr package manifest](https://github.com/robbeverhelst/Tsarr/blob/main/package.json),
the [npm package](https://www.npmjs.com/package/tsarr), and this repository's
`packages/rfmedia-cli/package.json` and `.github/workflows/rfmedia-cli.yml`.

A direct runtime spike on 2026-07-21 found that `tsarr/lidarr` can be imported,
constructed, and used for a mocked `GET /api/v1/artist` call on Node 22.0.0.
That is useful compatibility evidence, but it does not override Tsarr's supported
engine contract. The same spike observed `X-Api-Key` header authentication and a
typed `{ data, request, response }` result, but also observed `Request.redirect ===
"follow"`. The existing `rfmedia-cli` Lidarr transport intentionally uses
`redirect: "error"`, origin pinning, bounded bodies, strict parsing, secret
redaction, and its own error taxonomy. A package update could also start using a
Node 24-only feature without a major release because Node 22 is already outside
the supported range.

Recommendation: use Tsarr as a design and generated-output reference, but generate
and commit a local Lidarr client from the official Lidarr OpenAPI document. Pin the
spec by commit and the generator by exact lockfile version. Prefer
[`@hey-api/openapi-ts`](https://heyapi.dev/) because Tsarr proves it can consume
the current Lidarr spec and emit ESM/fetch TypeScript. Inject a hardened
`rfmedia-cli` fetch adapter into the generated client and call generated operations
directly; do not copy Tsarr's large hand-maintained facade. Keep the existing
`LidarrClientApi` as the application seam only if it delegates to generated
operations without owning paths, verbs, or response models.

**Inference:** local generation is lower risk than a Tsarr dependency because it
removes the Node 24 runtime constraint and shared-client behavior while retaining
the useful generated operation and model coverage. It also lets the project keep
its stronger request policy.

## Primary APIs

The authoritative checked-in API description is Lidarr's
[`src/Lidarr.Api.V1/openapi.json`](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/openapi.json),
also rendered at the official [Lidarr API documentation](https://lidarr.audio/docs/api/).
The raw source is available at
`https://raw.githubusercontent.com/Lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json`.
As observed on 2026-07-21, it is OpenAPI 3.0.4, contains 161 paths and 141 schemas,
and identifies itself as API version `1.0.0` under GPL-3.0. The file's Git blob was
`bd42875a7ad5f41ba1d00381a65fe21ee376d410`; the last commit touching it was
`3e2858439ff35b372d0af00bcea1b0a357572d26` on 2025-10-20.

The four operations currently used by `rfmedia-cli` are:

| CLI operation  | OpenAPI path                 | OpenAPI response              | Current behavior to preserve                     |
| -------------- | ---------------------------- | ----------------------------- | ------------------------------------------------ |
| System status  | `GET /api/v1/system/status`  | `SystemResource`              | Direct body; abortable                           |
| Health         | `GET /api/v1/health`         | `HealthResource[]`            | Direct body; abortable                           |
| Artists        | `GET /api/v1/artist`         | `ArtistResource[]`            | Direct body; optional `mbId` exists in spec      |
| Wanted/missing | `GET /api/v1/wanted/missing` | `AlbumResourcePagingResource` | Explicit page size 50 and sort key `releaseDate` |

The wanted endpoint's documented defaults are page `1`, page size `10`,
`includeArtist=false`, and `monitored=true`. The current CLI explicitly sends page
size `50`; generation must not silently revert behavior to the server default.

The document declares two alternative global API-key schemes: header
`X-Api-Key` and query parameter `apikey`. `rfmedia-cli` must configure only the
header form. The current client actively rejects authentication-like query keys
and values, so blindly allowing the generated query-key alternative would be a
security regression.

Spec realities relevant to code generation:

- The document has no `operationId` values. Generators therefore derive names
  from HTTP methods and paths, such as `getApiV1SystemStatus`. Generated names can
  change if generator naming rules change even when the wire API does not.
- `info.version` is `1.0.0`, not the installed Lidarr release version. Do not use
  it as a compatibility or freshness signal; query `SystemResource.version` at
  runtime instead.
- The `develop` URL is mutable. Reproducible builds need a checked-in snapshot or
  a commit-pinned raw URL, not live generation from `develop`.
- TypeScript types generated from OpenAPI are compile-time contracts, not runtime
  validation. Malformed JSON can still cross the boundary unless response
  validators or existing focused guards are retained.
- The canonically sorted JSON content of Tsarr's checked-in Lidarr spec and the
  official Lidarr `develop` spec was identical on 2026-07-21. Tsarr's snapshot is
  formatted differently, which explains its different byte hash and size.

## Libraries and SDKs

### Tsarr 2.12.0

Primary sources: [repository](https://github.com/robbeverhelst/Tsarr),
[SDK documentation](https://github.com/robbeverhelst/Tsarr/blob/main/docs/usage.md),
[package manifest](https://github.com/robbeverhelst/Tsarr/blob/main/package.json),
[Lidarr facade](https://github.com/robbeverhelst/Tsarr/blob/main/src/clients/lidarr.ts),
and [generation script](https://github.com/robbeverhelst/Tsarr/blob/main/scripts/generate.ts).

- Current and actively maintained as of 2026-07-21: v2.12.0 was published on
  2026-07-19 and the repository had activity on 2026-07-21. It is small
  (28 stars, 4 forks observed), so maintenance remains concentrated.
- MIT licensed. The upstream Lidarr spec embedded in the project declares
  GPL-3.0; attribution and treatment of vendored spec/generated output should be
  documented. This is not legal advice.
- ESM with modular exports including `tsarr/lidarr` and `tsarr/lidarr/types`.
- Published engine is `node >=24.16.0`; this is incompatible with the project's
  Node 22 support contract even though the observed Node 22 smoke call worked.
- Uses `@hey-api/openapi-ts` and a checked-in Lidarr spec. A scheduled workflow
  refreshes specs and opens a PR; see
  [`refresh-specs.yml`](https://github.com/robbeverhelst/Tsarr/blob/main/.github/workflows/refresh-specs.yml)
  and [`refresh-specs.ts`](https://github.com/robbeverhelst/Tsarr/blob/main/scripts/refresh-specs.ts).
- Its generated client supports custom fetch, headers, interceptors, and typed
  operations. However, the generated default is redirect-following, JSON parsing
  is not schema validation, and the public Lidarr class is a large handwritten
  endpoint facade. That facade conflicts with issue #194's goal of avoiding
  hand-maintained wrappers.
- The generated Lidarr client is a module singleton configured by each
  `LidarrClient` constructor. **Inference:** multiple differently configured
  Lidarr instances in one process can overwrite shared configuration; local
  generation should create an instance per connection instead.
- Tsarr returns structured results (`data`, `error`, `request`, `response`) rather
  than the direct validated bodies returned by the current client. Direct package
  replacement would require action-layer changes or a compatibility adapter.

### `@hey-api/openapi-ts`

The current package is ESM, MIT licensed, and generates typed clients/SDKs from
OpenAPI. Its official site documents Fetch API output and optional runtime schema
generation. Tsarr currently pins `^0.98.2`; the npm latest observed was `0.99.0`
with `node >=22.18.0` and TypeScript `>=5.5.3` peer support. That generator engine
is acceptable in current Node 22 CI only if CI resolves Node 22.18 or newer, but it
is newer than `rfmedia-cli`'s declared minimum Node 22.0. Generated output can
still target Node 22.0 because the generator is a development dependency.

Best fit when full named operations and models should be committed. Pin an exact
version, configuration, and spec; do not depend on caret updates for deterministic
output. Configure a per-instance client, custom fetch, and header auth.

### `openapi-typescript` plus `openapi-fetch`

Primary sources: [openapi-typescript](https://openapi-ts.dev/),
[openapi-fetch](https://openapi-ts.dev/openapi-fetch/), and
[middleware/authentication](https://openapi-ts.dev/openapi-fetch/middleware-auth).
The observed releases were `openapi-typescript@7.13.0` and
`openapi-fetch@0.17.0`, both ESM and MIT licensed.

This alternative generates only a `paths`/schema type file and uses a small
generic runtime client (`client.GET("/api/v1/artist")`). It naturally avoids
hand-maintained endpoint wrappers, accepts a custom fetch, and has middleware for
auth/error policy. Its path-string call sites remain checked against the generated
type map, but operation names are not generated. This is the simplest fallback if
Hey API's emitted runtime conflicts with the existing hardened transport.

### OpenAPI Generator `typescript-fetch`

Primary source: the official
[`typescript-fetch` generator documentation](https://openapi-generator.tech/docs/generators/typescript-fetch/).
The npm CLI observed was `@openapitools/openapi-generator-cli@2.40.0`, Apache-2.0,
with Node `>=22.0.0`. The TypeScript Fetch generator is marked stable and supports
API-key authentication, but the CLI brings a Java-based generator/tool download,
larger output, and more template/configuration surface. It is a viable fallback,
not the preferred first choice for this ESM monorepo.

Orval 8.22.0 was also checked, but its current generator requires Node 22.18 and
adds a much larger plugin/dependency surface than this four-operation integration.
It offers no clear advantage here.

## Integration Patterns

1. Commit a normalized snapshot at a project-owned path such as
   `packages/rfmedia-cli/openapi/lidarr-v1.json`. Record the upstream commit and
   source URL in an adjacent metadata file or generation script.
2. Add exact-pinned development-only codegen dependencies and scripts such as
   `codegen:lidarr`, `codegen:lidarr:check`, and `refresh:lidarr-spec`. Normal
   `build` should use checked-in output and must not access the network.
3. Generate into `packages/rfmedia-cli/src/lib/lidarr/generated/`. Add a header
   saying the directory is generated and exclude it from manual formatting rules
   if formatting changes would prevent deterministic regeneration.
4. Create a generated client instance per `LidarrClient`, injecting base URL,
   `X-Api-Key`, and a hardened fetch adapter. Do not use a mutable module-global
   client. Ensure the adapter rejects redirects, pins the origin, composes caller
   cancellation with timeout, bounds success/error bodies, and maps failures into
   existing `LidarrError` subclasses.
5. Make generated operations/models the source of truth. Existing public narrow
   types can become projections or aliases where structurally safe; avoid copying
   generated wire declarations into `src/types/lidarr.ts`.
6. Preserve the action-facing return contract deliberately. Either update actions
   to consume generated `{ data, error, response }` results, or unwrap once in a
   stable application adapter. The adapter may supply CLI defaults and domain
   error mapping, but must not hand-code paths, verbs, or response wire types.
7. Keep runtime validation for the fields the CLI consumes. Options are existing
   guards typed against generated models or generated runtime schemas. Do not
   treat TypeScript declarations as validation.

Recommended drift gates:

- Regenerate from the checked-in spec and fail CI on `git diff --exit-code` for
  the generated directory. This detects generator/config/lockfile drift.
- Separately refresh the upstream spec and open a reviewed PR when canonical JSON
  changes. Network refresh should be scheduled/manual, not part of ordinary CI.
- Add compile-time contract tests asserting the four generated operations and
  required response projections still exist.
- Add mocked request contract tests for exact paths, wanted query defaults,
  header-only API key, no secret in URLs/errors, caller abort, timeout, body caps,
  response validation, and `redirect: "error"`.
- Add a spec fixture test that asserts both API-key schemes are still present but
  that runtime configuration selects only `X-Api-Key`.
- Pin generator version in `package-lock.json`; record the spec canonical SHA-256
  so refresh PRs show intentional provenance changes.

## Constraints and Gotchas

- Tsarr's working Node 22 smoke result is not a support guarantee. Its manifest
  currently permits maintainers to ship Node 24-only syntax or APIs.
- `@hey-api/openapi-ts@0.99.0` needs Node 22.18 for generation. Either raise the
  developer/CI floor to 22.18, pin a compatible release, or run codegen in a
  dedicated newer tool environment while keeping emitted runtime compatible with
  Node 22.0.
- Generated fetch clients normally follow redirects. A redirect can forward an
  API-key header to an unintended target depending on fetch redirect rules and
  deployment topology. Preserve the current explicit rejection policy.
- The spec allows the API key in a query string. Query credentials leak through
  logs, histories, and telemetry more readily than headers; never configure this
  alternative.
- Generated clients do not reproduce current body-size limits, strict UTF-8 JSON
  handling, redaction, retry classification, or `Retry-After` parsing by default.
- The spec lacks operation IDs. Generator upgrades may rename every derived
  function. Pinning plus a generated-diff review is essential.
- Generated models are broad and often optional/nullable. The CLI's existing
  minimal types are stricter for fields it actually needs. Migration must not
  turn malformed responses into later `undefined` failures.
- Tsarr's facade uses broad `any`-typed operation slots and manually maps many
  endpoint methods. Importing it would not fully satisfy the no-hand-maintained-
  wrapper requirement.
- The official spec lives on the mutable `develop` branch and was last updated by
  an automated docs commit. A Lidarr binary may diverge from that snapshot.
  **Inference:** a future optional live-instance contract test is useful, but it
  should supplement—not replace—the committed reproducible spec.
- Vendoring the GPL-3.0-labelled Lidarr specification requires retaining source
  and license attribution. Confirm project policy for generated artifacts before
  publishing them under the package's MIT metadata.

## Code Examples

Illustrative Hey API generation configuration (verify exact plugin names against
the pinned release before implementation):

```ts
import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./openapi/lidarr-v1.json",
  output: "./src/lib/lidarr/generated",
  plugins: ["@hey-api/typescript", "@hey-api/sdk", "@hey-api/client-fetch"],
});
```

Use a per-instance generated client and force header authentication through the
project's transport policy:

```ts
import { createClient } from "./generated/client/index.js";
import { getApiV1Artist } from "./generated/sdk.gen.js";

const generated = createClient({
  baseUrl: connection.origin,
  headers: { "X-Api-Key": await apiKeyProvider.getApiKey() },
  fetch: createHardenedLidarrFetch(connection),
  throwOnError: true,
});

const result = await getApiV1Artist({ client: generated, signal });
return validateArtists(result.data);
```

An `openapi-typescript`/`openapi-fetch` fallback avoids generated operation
wrappers while retaining path checking:

```ts
import createClient from "openapi-fetch";
import type { paths } from "./generated/lidarr-schema.js";

const client = createClient<paths>({
  baseUrl: connection.origin,
  fetch: createHardenedLidarrFetch(connection),
  headers: { "X-Api-Key": await apiKeyProvider.getApiKey() },
});

const { data, error, response } = await client.GET("/api/v1/wanted/missing", {
  params: {
    query: { page: 1, pageSize: 50, sortKey: "releaseDate" },
  },
  signal,
});
```

A deterministic CI gate should regenerate only from committed inputs:

```json
{
  "scripts": {
    "codegen:lidarr": "openapi-ts -f openapi-ts.lidarr.config.ts",
    "codegen:lidarr:check": "npm run codegen:lidarr && git diff --exit-code -- src/lib/lidarr/generated"
  }
}
```

## Open Questions

- Is Node 22.0 genuinely a supported consumer minimum, or may the project raise
  it to Node 22.18? This changes which current generator versions can run inside
  the normal workspace.
- Should generated files and the normalized spec be committed, or should a
  release build generate them in a pinned container? Committing is recommended
  for offline builds and reviewable drift.
- Does project policy allow a GPL-3.0-labelled API document in the MIT npm package,
  and what attribution must accompany generated output?
- Should the public `LidarrClientApi` keep direct-body returns for compatibility,
  or should actions adopt generated result envelopes? The decision should be made
  explicitly before implementation.
- Should runtime response validation remain focused on the four consumed shapes,
  or should codegen emit validators for all generated models? Focused validation
  is smaller and matches current behavior; full validators improve future reuse
  but expand output and runtime cost.
- Is multi-instance Lidarr support a future requirement? Even if not, a
  per-instance client avoids Tsarr's global configuration hazard at negligible
  cost.
- Should upstream spec refresh be a scheduled GitHub workflow that opens a PR, or
  a manually invoked maintainer script? Both must keep ordinary build/test
  network-free.
- Is there a representative Lidarr container version that CI can start for an
  optional live contract test, in addition to deterministic mocked tests?
