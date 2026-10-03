# Lidarr Generator Runtime Spike

## Decision

Keep `@hey-api/openapi-ts` at exact version `0.93.0` as a development-only dependency of the
`rfmedia` workspace. Configure `@hey-api/client-fetch` with `bundle: true`, TypeScript models, and a
flat SDK whose operations require an explicit client (`auth: false`, `client: false`). Do not add an
`@hey-api/client-fetch` runtime dependency.

The candidate passed the required Node 22 runtime invariants: NodeNext `.js` imports, four named
operations, per-instance clients, a custom Fetch receiving one `Request`, bounded reconstructed
`Response` parsing, and concurrent two-client isolation. One compile-only defect is fail-closed and
must be normalized deterministically by Task 1.3: the raw bundled client contains exactly two
`BodyInit` casts, while this repository deliberately uses `lib: ["ES2023"]` without DOM globals.
Replace exactly those two matches with `RequestInit['body']`, fail on zero or any count other than
two, and then compile the complete generated tree. The normalization changes types only; it does not
change runtime code or weaken the package tsconfig.

The raw candidate failed strict compilation as follows:

```text
generated/client/client.gen.ts(244,26): error TS2304: Cannot find name 'BodyInit'.
generated/client/client.gen.ts(256,52): error TS2304: Cannot find name 'BodyInit'.
```

After the exact two-match normalization, the complete generated tree compiled under the unchanged
package-equivalent strict NodeNext settings and the runtime probe passed on Node `v22.23.1`. No
fallback was selected. If a future generator emits zero, one, or more than two matches, or if the
replacement no longer compiles, generation must stop rather than add `DOM`, raise the Node floor, or
hand-edit generated files. The only approved fallback remains exact
`openapi-typescript@7.13.0` plus exact `openapi-fetch@0.17.0`.

## Reproducible Inputs

| Input                                       | Value                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Node runtime used for generation and probes | `v22.23.1`                                                                                        |
| npm                                         | `11.17.0` lockfile writer; lockfile version 3                                                     |
| Generator                                   | `@hey-api/openapi-ts@0.93.0`                                                                      |
| Generator engine                            | `>=20.19.0`                                                                                       |
| Generator tarball                           | `https://registry.npmjs.org/@hey-api/openapi-ts/-/openapi-ts-0.93.0.tgz`                          |
| Generator integrity                         | `sha512-LzYpKHRSasPGJFP+UvgrvlhLBa5W0roqKJKAJCTbAMpAKutC0jcWegkYXD3m85RFpBU2aXFDJrG99hf3xw1QMA==` |
| Lidarr input commit                         | `3e2858439ff35b372d0af00bcea1b0a357572d26`                                                        |
| Lidarr input path                           | `src/Lidarr.Api.V1/openapi.json`                                                                  |
| Temporary input SHA-256                     | `4ae9e79e9662898ed4704ce80f091161587a9f0d664f9e518b11a038616e491f`                                |
| Temporary input bytes                       | `316102`                                                                                          |

The spike used this effective generator configuration:

```js
export default {
  input: "/absolute/path/to/lidarr-v1.json",
  output: {
    path: "/absolute/path/to/generated",
    importFileExtension: ".js",
    tsConfigPath: "/absolute/path/to/packages/rfmedia-cli/tsconfig.json",
  },
  plugins: [
    { name: "@hey-api/client-fetch", bundle: true },
    "@hey-api/typescript",
    { name: "@hey-api/sdk", auth: false, client: false },
  ],
};
```

Task 1.2 must make the paths package-relative and local-only. Task 1.3 must apply the asserted
type-only normalization before hashing, formatting, compiling, or replacing the committed tree.

## Generated Contract

All generated relative imports used `.js` specifiers. The four required emitted operation names
were:

- `getApiV1SystemStatus`
- `getApiV1Health`
- `getApiV1Artist`
- `getApiV1WantedMissing`

The wanted operation serialized the preserved defaults as
`?page=1&pageSize=50&sortKey=releaseDate`; a supplied descending direction serialized as
`?page=2&pageSize=25&sortDirection=descending&sortKey=releaseDate`.

At runtime, successful calls returned own keys `data`, `request`, and `response`. HTTP failures
returned own keys `error`, `request`, and `response`; a mocked `503` JSON body produced
`error: { message: "unavailable" }`. Fetch exceptions returned `error`, `request`, and an undefined
`response`. These envelopes must remain private to `client.ts`.

The injected Fetch was called with exactly one argument, a final generated `Request`; no separate
`RequestInit` argument was supplied. The generated request had method `GET` and redirect mode
`follow`. The spike's transport-shaped Fetch rebuilt it with `new Request(request, { redirect:
"error" })`, injected the mock origin-bound key at that boundary, fully consumed a mock upstream
response, returned a bounded reconstructed `Response`, and the generated parser consumed it
successfully.

Two clients with distinct base URLs and Fetch closures were exercised concurrently. Every A call
used `https://lidarr-a.example.test` with `key-a`, and every B call used
`https://lidarr-b.example.test` with `key-b`. There was no global configuration cross-talk.

## Bundled Fetch Runtime Identity

Version `0.93.0` does not publish a separately meaningful version for the client source copied by
the built-in `@hey-api/client-fetch` plugin. Its reproducible identity is therefore the exact
generator tarball/integrity above, the explicit configuration, the lockfile, and the emitted file
hashes below. No generated file imported the npm package `@hey-api/client-fetch`.

| Bundled file                     | Raw SHA-256                                                        |
| -------------------------------- | ------------------------------------------------------------------ |
| `client/client.gen.ts`           | `9dc5b7bc763a06539beec1a4396b8d1b807208f174e819f3cac7dca28d04cfbd` |
| `client/index.ts`                | `c50d41725f6889724224a3e39bb10c399c764799fbc0fee5c2b0b1f8def3224a` |
| `client/types.gen.ts`            | `c23034303dd9f8657e63771ca6a7b93fd99ddb9232ec4cb774b48905abf913fa` |
| `client/utils.gen.ts`            | `df6738845c0f2f648f7e8248556adea2f0f8d44690c175da9294073b60d3cf4f` |
| `core/auth.gen.ts`               | `dd54b258145c9a9b2fb58dce516e13e20075ee726e7fd4a19e04610f96f5d338` |
| `core/bodySerializer.gen.ts`     | `8967856966a98e6f8cbc2d94c0fdeba21901edfedd9eb5f11376a968aa826290` |
| `core/params.gen.ts`             | `39d0889fc384e7731c91ad9b0a6f783bf7feb37d77384dc5a859d5b85a12e092` |
| `core/pathSerializer.gen.ts`     | `41449b1807cd47b280b2c16e9684ec297b867e11f9f90dd1cb053408b58ed387` |
| `core/queryKeySerializer.gen.ts` | `293a195d9a833f829ab172b024d68186d6a19e6b3636f14ae9b9d10858e7bfd0` |
| `core/serverSentEvents.gen.ts`   | `e773e599ccddc82ef00000323ba9c5e6cad3ab1ef75dc3417b4575b14e17c61a` |
| `core/types.gen.ts`              | `c0db1d86de1cb243e5c993ccc2e200f8fa557b4e9121a760772212b630236836` |
| `core/utils.gen.ts`              | `eba93e576e47320672acbd29293965f0bdbf29984badcd66b6e3301e26bc95f1` |

The normalized `client/client.gen.ts` SHA-256 was
`8b05351965da027de4a49b86aa86b26ed447f7008eae8bd9337916b8bdd81e6c`. Task 1.3 must recompute and
assert final emitted hashes after its stable machine-owned header and formatting steps; these spike
hashes identify the raw and type-normalized runtime, not the future committed tree.

## TsArr Rejection

`tsarr@2.12.0` was installed only in a temporary directory and never entered the workspace manifest
or lockfile. Its published engine is `node >=24.16.0`, so it does not support the repository's Node
22 contract. A direct Node `v22.23.1` smoke probe nevertheless imported `tsarr/lidarr`, constructed
two `LidarrClient` instances, and completed mocked `GET /api/v1/artist` calls. A successful result had
the own keys `data`, `request`, and `response`, and authentication used the `X-Api-Key` header.

That smoke success does not overcome the support or security failures:

- Both calls, including the call through the first client, used the second client's origin and
  `key-b`. Construction mutates one generated module-global client, so two-instance isolation fails.
- The Request presented to the mocked network Fetch used redirect mode `follow`.
- The package engine allows a non-major update to begin using Node 24-only behavior while Node 22 is
  already unsupported.
- The broad handwritten TsArr facade would replace one maintained wrapper with another and does not
  preserve rfmedia's bounded parsing, strict projections, or error taxonomy.

Conclusion: TsArr remains reference evidence only and is rejected as a dependency.

## Commands and Outcomes

The spike used an isolated temporary directory. The important rerunnable commands were:

```bash
npm install --ignore-scripts --workspace packages/rfmedia-cli
npm rebuild --prefix /tmp/rfmedia-lidarr-spike.e0xFFm node
/tmp/rfmedia-lidarr-spike.e0xFFm/node_modules/.bin/node --version
/tmp/rfmedia-lidarr-spike.e0xFFm/node_modules/.bin/node \
  node_modules/@hey-api/openapi-ts/bin/run.js \
  --file /tmp/rfmedia-lidarr-spike.e0xFFm/openapi-ts.config.mjs --no-log-file
/tmp/rfmedia-lidarr-spike.e0xFFm/node_modules/.bin/node \
  node_modules/typescript/bin/tsc \
  --project /tmp/rfmedia-lidarr-spike.e0xFFm/tsconfig.json
/tmp/rfmedia-lidarr-spike.e0xFFm/node_modules/.bin/node \
  /tmp/rfmedia-lidarr-spike.e0xFFm/compiled/probe.js
cd /tmp/rfmedia-lidarr-spike.e0xFFm && ./node_modules/.bin/node ./tsarr-probe.mjs
```

Generation completed under Node 22. The raw compile failed only on the two `BodyInit` names. The
asserted two-match replacement produced zero remaining `BodyInit` matches, exactly two
`RequestInit['body']` matches, a clean strict compile, and a passing mock runtime probe. The TsArr
probe completed and reproduced global origin/key cross-talk plus redirect-following behavior.

Workspace validation also confirmed:

- `npm ls @hey-api/openapi-ts --workspace packages/rfmedia-cli --depth=0` resolved exactly `0.93.0`.
- `npm ls @hey-api/client-fetch tsarr openapi-fetch openapi-typescript --workspace
packages/rfmedia-cli --all` returned an empty tree.
- `@hey-api/openapi-ts` and its support graph are lockfile `dev: true`; the rfmedia workspace gained
  no production dependency.
- The package engine remains `>=22.0.0`; no Bun dependency or lifecycle hook was added.
