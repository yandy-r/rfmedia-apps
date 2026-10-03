## Executive Summary

Issue #194 should use local OpenAPI generation, not a runtime dependency on TsArr. The July 2026
TsArr spike produced two decisive incompatibilities:

- `tsarr@2.12.0` declares `engines.node >=24.16.0`, while rfmedia-cli declares and tests Node 22+.
  Its ESM bundle imports and performs a mocked request under Node 22.0.0/22.22.0, but an accidental
  smoke-test success is not a supported runtime contract.
- TsArr's `LidarrClient` configures a module-scoped generated client. Creating clients for two
  origins and then invoking the first sent its request to the second origin with the second API key.
  That global mutable configuration conflicts with rfmedia-cli's origin-bound credential model and
  test isolation.

TsArr also returns generator envelopes (`{ data, error, request?, response? }`) and cannot replace
rfmedia-cli's existing security policy or stable four-method action seam without an adapter. The
recommended architecture therefore vendors a pinned Lidarr OpenAPI snapshot, generates a private
NodeNext-compatible SDK with an exact `@hey-api/openapi-ts` version, and keeps a small handwritten
adapter that owns security, runtime normalization, and the existing `LidarrClientApi` contract. No
handwritten module may own endpoint paths, query serialization, or Lidarr wire schemas.

This change needs no database, migration, daemon, or new server API. It changes an outbound HTTP
integration only. It also adds no CLI command or option, so Bash, Zsh, and Fish templates should
remain byte-for-byte unchanged; their existing Lidarr command-tree tests are the evidence that no
completion update is required.

## Architecture Design

### Proposed component boundary

```text
Commander commands
       |
       v
actions/lidarr/{status,list,wanted,health}.ts
       |  depends only on LidarrClientApi
       v
lib/lidarr/client.ts                     types/lidarr.ts
  handwritten adapter                   stable normalized domain projections
  - generated operation selection       (not raw OpenAPI models)
  - result/error normalization
  - required-field validation
       |
       v
lib/lidarr/transport.ts
  - origin pinning                 +--> lib/lidarr/errors.ts
  - X-Api-Key injection                 stable error taxonomy
  - redirect rejection
  - timeout/abort composition
  - bounded bodies and redaction
       |
       v
lib/lidarr/generated/*
  generated client + SDK + raw models
  NO manual edits; NO upper-layer imports
       ^
       |
openapi/lidarr-v1.json -- openapi-ts.config.mjs -- scripts/generate-lidarr-client.mjs
       ^
       |
explicit refresh command from a commit-pinned upstream Lidarr spec
```

The adapter is deliberately narrower than the generated SDK. Future Lidarr features add a domain
capability to `LidarrClientApi` only when an action needs it; they never add a manually constructed
path or request body. The complete generated SDK may contain all Lidarr endpoints, but remains a
private infrastructure dependency.

### Generator selection

Use exact `@hey-api/openapi-ts@0.93.0` as the initial pinned generator. It declares Node
`>=20.19.0`, accepts the repository's TypeScript 5.7 peer, supports the Fetch client, and supports
`output.importFileExtension: ".js"`/`output.tsConfigPath` for NodeNext. Do not use a caret range.
`package-lock.json` must record the exact dependency graph.

Selection/re-evaluation criteria are executable rather than subjective:

1. The generator must run on every Node version allowed by rfmedia-cli's `engines` field.
2. Generated source must typecheck with `target: ES2023`, `module: NodeNext`, strict flags, and
   `.js` relative import specifiers.
3. Generated runtime code must use standard Fetch/URL/AbortController APIs and must not require Bun.
4. A generated client must be instance-scoped; two connections must not share base URL, headers,
   fetch implementation, or mutable configuration.
5. Operations required by the current seam must exist with typed success models:
   `getApiV1SystemStatus`, `getApiV1Health`, `getApiV1Artist`, and
   `getApiV1WantedMissing`.
6. The adapter must be able to inject rfmedia-cli's secure fetch implementation and caller signal.
7. Re-running generation from identical inputs must produce byte-identical output.

TsArr may be reconsidered only if its published `engines` includes the full supported Node range,
its exported Lidarr client passes the two-instance isolation contract, and it preserves equivalent
transport hooks. Passing only an import smoke test is insufficient.

### Deterministic generation and drift flow

- Check in `packages/rfmedia-cli/openapi/lidarr-v1.json` as the source snapshot. The snapshot is
  downloaded only by an explicit refresh command, never as part of build, test, or normal codegen.
- Record source repository, upstream commit SHA, source URL, SHA-256, generator package/version, and
  config schema version in `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`. Do not record a
  timestamp, local path, host name, or other nondeterministic value.
- `npm run codegen:lidarr` deletes/replaces only `src/lib/lidarr/generated/`, generates from the
  local snapshot, applies the checked-in config, formats with the repository's pinned Prettier, and
  writes the deterministic manifest into the generated directory.
- `npm run codegen:lidarr:check` generates into a temporary directory and performs a recursive,
  byte-for-byte comparison against the committed output. It must not modify the working tree.
- `npm run openapi:lidarr:refresh` fetches the upstream `develop` spec, resolves the exact upstream
  commit, validates JSON/OpenAPI structure and the four required operations, updates the snapshot
  and manifest, regenerates, and leaves the diff for review.
- Normal CI runs the offline `codegen:lidarr:check`. A scheduled/manual workflow may run the network
  refresh check and open a dedicated drift PR; upstream availability must not make ordinary PR CI
  flaky.

## Data Models

There is no persistent data model and no schema migration. The only durable artifacts are a public
OpenAPI snapshot, its provenance manifest, and generated TypeScript source.

Generated OpenAPI models are wire models and stay private under `lib/lidarr/generated/`. They are
often nullable/optional because that is what the upstream schema describes. Actions continue to
consume normalized rfmedia domain types from `src/types/lidarr.ts`:

```typescript
export interface LidarrSystemStatus {
  readonly version: string;
  readonly instanceName?: string;
}

export interface LidarrArtist {
  readonly id: number;
  readonly artistName: string;
  readonly foreignArtistId: string;
  readonly monitored: boolean;
  readonly qualityProfileId: number;
  readonly metadataProfileId: number;
  readonly tags: readonly number[];
  readonly path?: string;
  readonly statistics?: LidarrArtistStatistics;
}

export interface LidarrWantedPage {
  readonly page: number;
  readonly pageSize: number;
  readonly totalRecords: number;
  readonly records: readonly LidarrWantedRecord[];
}
```

These are domain projections, not copied API schemas. Adapter projectors accept the generated raw
types (`SystemResource`, `ArtistResource`, `PagingResource`, `HealthResource`) and reject missing or
wrongly typed fields required by rfmedia-cli. This retains current invalid-response behavior while
allowing unrelated upstream fields to evolve without action churn. `src/types/lidarr.ts` should
remove comments and coupling that describe its declarations as handwritten wire contracts.

The manifest contract should be versioned and machine-readable:

```typescript
interface LidarrOpenApiManifestV1 {
  readonly schemaVersion: 1;
  readonly upstream: {
    readonly repository: "Lidarr/Lidarr";
    readonly commit: string;
    readonly path: "src/Lidarr.Api.V1/openapi.json";
  };
  readonly specSha256: string;
  readonly generator: "@hey-api/openapi-ts@0.93.0";
  readonly configVersion: 1;
}
```

## API Design

The action-facing interface remains source-compatible, so commands, result envelopes, and shell
completion surfaces do not change:

```typescript
export interface LidarrClientApi {
  getSystemStatus(signal?: AbortSignal): Promise<LidarrSystemStatus>;
  getHealth(signal?: AbortSignal): Promise<readonly LidarrHealthCheck[]>;
  listArtists(signal?: AbortSignal): Promise<readonly LidarrArtist[]>;
  getWantedMissing(query?: LidarrWantedQuery): Promise<LidarrWantedPage>;
}

export interface LidarrWantedQuery {
  readonly page?: number;
  readonly pageSize?: number;
  readonly sortKey?: string;
  readonly sortDirection?: "ascending" | "descending";
  readonly signal?: AbortSignal;
}
```

The generated boundary is instance-scoped and private:

```typescript
interface LidarrTransport {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface GeneratedLidarrGateway {
  readonly client: GeneratedClient;
  getSystemStatus(signal?: AbortSignal): Promise<LidarrSystemStatus>;
  getHealth(signal?: AbortSignal): Promise<readonly LidarrHealthCheck[]>;
  listArtists(signal?: AbortSignal): Promise<readonly LidarrArtist[]>;
  getWantedMissing(query?: LidarrWantedQuery): Promise<LidarrWantedPage>;
}
```

Each adapter method calls a generated operation with the per-instance generated client, for example:

```typescript
const result = await getApiV1WantedMissing({
  client: this.#generatedClient,
  query: {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 50,
    sortKey: query.sortKey ?? "releaseDate",
    sortDirection: query.sortDirection,
    includeArtist: true,
  },
  signal: query.signal,
});
```

The exact property names above must be confirmed against the pinned generated `Options` type during
implementation; TypeScript compilation is the contract. The adapter may select and normalize a
generated operation, but it must not contain path strings or serialize query/body fields outside
the generated operation's typed options.

Generated errors/results are translated once into the existing `LidarrError` hierarchy. Preserve
status classification, `Retry-After`, retryability, cancellation identity, credential redaction,
and invalid-response semantics. Raw response bodies and API keys must never enter error messages,
causes, logs, reflected object fields, or JSON output.

## System Constraints

- Runtime: Node.js 22+ as currently declared; no Bun runtime or Bun type dependency.
- Module system: ESM/NodeNext with `.js` relative imports in generated TypeScript.
- TypeScript: existing strict flags, including `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`, `isolatedModules`, and `verbatimModuleSyntax`.
- Network trust: only HTTP(S) canonical origins accepted; no embedded credentials, paths, query, or
  fragments in the configured base URL.
- Authentication: `X-Api-Key` header only. Credentials are origin-bound and absent from query
  strings, serialization, reflection, logs, and error causes.
- Redirects: rejected to prevent credential forwarding to a different origin.
- Resource limits: preserve bounded success/error bodies and hard timeouts. If the generated Fetch
  client parses bodies internally, the injected fetch must bound/reconstruct the `Response` before
  returning it rather than dropping the limit.
- Cancellation: compose caller abort with the timeout and preserve the caller's abort reason.
- Concurrency: separate clients must remain isolated even when used concurrently.
- Generated source: committed, reproducible, formatted, and never manually edited.
- Builds/tests: normal CI and package builds are offline with respect to Lidarr upstream.
- Public exports: generated modules are private and are not added to the package/type barrel.
- CLI compatibility: no command, flag, JSON envelope, help text, or completion template changes.

## Codebase Changes

Implementation should modify/add the following files (generated output is listed as one artifact
set):

- `packages/rfmedia-cli/openapi/lidarr-v1.json` — checked-in upstream snapshot.
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json` — immutable provenance and tool contract.
- `packages/rfmedia-cli/openapi-ts.config.mjs` — single Lidarr job, Fetch client, full SDK/types,
  `tsConfigPath: "./tsconfig.json"`, `.js` import extensions, clean output, stable formatting.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` — write/check modes, manifest validation,
  temporary generation, recursive comparison, and required-operation assertions.
- `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.mjs` — explicit network refresh with resolved
  upstream commit and SHA-256 update.
- `packages/rfmedia-cli/src/lib/lidarr/generated/*` — committed generated client, SDK, and models;
  generated header says not to edit.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts` — extracted secure Fetch-compatible transport.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts` — retain `LidarrClientApi`; replace manual paths and
  guards with generated operations plus domain projection/error mapping.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` — retain connection/credential internals; remove
  handwritten wire guards now covered by generated types and adapter normalization.
- `packages/rfmedia-cli/src/types/lidarr.ts` — describe stable action-facing projections rather than
  handwritten wire schemas.
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts` — generated-operation integration,
  normalization, security, body-bound, abort, error, and two-client isolation tests.
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts` — compile/runtime contract for
  required generated operations and representative response models.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and its tests — rename/generalize the
  fetch-owner rules or authorize `transport.ts`, and add a rule that only the Lidarr adapter may
  import `lib/lidarr/generated/`.
- `packages/rfmedia-cli/package.json`, root `package-lock.json` — exact generator dependency and
  `codegen:lidarr`, `codegen:lidarr:check`, `openapi:lidarr:refresh` scripts; include the offline
  drift check in `pretypecheck` or `check:architecture`.
- `.github/workflows/rfmedia-cli.yml` — explicit offline codegen drift step before typecheck/tests;
  optionally add a separate scheduled/manual upstream-refresh job or workflow.
- `ROADMAP.md` — mark #194 shipped and record the chosen local OpenAPI strategy/PR once merged.

No changes are expected in `actions/lidarr/*`, `commands/lidarr.ts`, or the Bash/Zsh/Fish completion
generators unless the stable `LidarrClientApi` contract cannot be preserved. Their existing tests
should run unchanged as compatibility evidence.

## Technical Decisions

1. **Reject current TsArr as a production dependency.** Its declared Node floor is above the
   project's supported runtime, and its module-global client configuration failed isolation. This
   is a compatibility result, not a judgment on TsArr's generated models.
2. **Generate locally from a checked-in snapshot.** Builds are reproducible and independent of
   GitHub/Lidarr availability; upstream drift becomes an explicit reviewed change.
3. **Pin `@hey-api/openapi-ts@0.93.0` exactly.** It satisfies Node 22, TypeScript 5.7, Fetch, and
   NodeNext generation requirements. Upgrades require a generated diff and the same contract suite.
4. **Commit generated code.** Consumers and CI do not need the generator at runtime, and reviewers
   can see API drift. Generated output is treated as replace-only.
5. **Preserve the action seam and domain projections.** This prevents generator naming/nullability
   changes from leaking through commands and JSON output.
6. **Preserve a handwritten transport, not handwritten endpoints.** Security policy is
   application-specific and cannot safely be delegated to raw generated defaults. All endpoint
   identity and serialization comes from generated operations.
7. **Keep generated code private.** Upper layers import `LidarrClientApi`/domain types only. An
   architecture check enforces this direction.
8. **Separate snapshot drift from generated drift.** Every PR checks deterministic regeneration
   offline; scheduled/manual automation checks whether upstream changed.
9. **Do not update completions for this issue.** The command surface is unchanged; the existing
   cross-shell Lidarr template test remains the contract.
10. **Do not add persistence or a service.** Code generation is a development workflow and the
    runtime remains a direct outbound API client.

## Open Questions

- Should the repository keep rfmedia-cli's runtime floor at `>=22.0.0` indefinitely, or separately
  raise it to a maintained Node 22 patch level? This design does not require a runtime-floor change.
- Should upstream drift automation open a PR automatically, or only fail a scheduled dispatch and
  notify maintainers? Automatic PRs are useful but need token/branch-policy approval outside the
  client architecture.
- Does the pinned Lidarr spec model `wanted/missing` with a reusable generic paging resource or a
  concrete album paging type? The adapter contract is unaffected, but the projector's generated
  input type must follow the actual emitted model.
- Should the complete Lidarr SDK be generated now for future issues, or should generation filter to
  the four baseline operations? Full generation better satisfies the no-manual-wrapper objective
  and future epic work; operation filtering may reduce review size if the generator can prove
  deterministic inclusion.
- Is `@hey-api/openapi-ts@0.93.0` acceptable as a deliberately pinned older generator, or should the
  repository first raise the development-tool Node floor to 22.18 and pin 0.99.0? Runtime output can
  support Node 22 either way, but contributor install compatibility should be an explicit choice.
