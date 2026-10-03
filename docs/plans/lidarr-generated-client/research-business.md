# Business Research — Lidarr Generated Client

## Executive Summary

Issue #194 is an architectural sustainability change, not a new user-facing command. Its value is
to let future Lidarr work use the upstream API safely without growing another hand-maintained set of
paths, request DTOs, response DTOs, and endpoint-specific transport code. The four shipped read-only
commands (`status`, `list`, `wanted`, and `health`) must remain behaviorally stable while their wire
implementation moves behind generated operations.

The recommended decision is **local OpenAPI generation**, using a pinned Lidarr specification and a
pinned `@hey-api/openapi-ts` toolchain. The TsArr spike is still required and its evidence should be
recorded, but TsArr is not a sustainable dependency for the repository's present contract:

- The issue's researched version, TsArr 1.11.0, declares Bun `>=1.0.0`, while rfmedia-cli is a
  Node-only application.
- The current TsArr 2.12.0 has moved to Node but declares Node `>=24.16.0`; rfmedia-cli declares Node
  `>=22.0.0` and CI uses Node 22.
- An intermediate release such as 2.4.12 declares a compatible engine, but pinning an old release
  would strand upgrades rather than solve long-term drift.
- TsArr's public `LidarrClient` is itself a hand-maintained convenience wrapper around generated
  operations. The generated Lidarr operations are not the supported public import surface, so using
  TsArr would retain the wrapper-maintenance risk this issue is intended to remove.
- TsArr configures an imported generated-client singleton. That does not satisfy rfmedia-cli's
  stronger origin-bound, injected-transport, secret-isolation contract without an additional
  repository-owned policy boundary.

Local generation should not expose generated code directly to commands or actions. The existing
`LidarrClientApi` remains the stable application seam; its implementation configures generated
operations and applies rfmedia-cli policies. Generated code owns endpoint paths and wire DTOs. The
repository-owned boundary owns authentication, origin pinning, timeout/cancellation, response-size
limits, runtime validation of consumed projections, error taxonomy, and secret redaction. This is a
policy adapter, not a second hand-written SDK.

## User Stories

- As an operator, I can upgrade rfmedia-cli without the existing Lidarr commands changing their
  flags, output fields, pagination defaults, exit behavior, or error classifications solely because
  the transport implementation became generated.
- As an operator on any supported Node 22+ runtime, I do not need Bun or a second runtime to install,
  build, or run rfmedia-cli.
- As a maintainer, I can refresh a pinned Lidarr OpenAPI snapshot and regenerate the client with one
  documented command, review the resulting API delta, and reproduce the same output from the same
  inputs.
- As a reviewer, I can tell whether a change came from the upstream schema, the generator/config,
  or hand-written policy code, and CI fails when generated output does not match its checked-in
  inputs.
- As a contributor to later Lidarr issues, I can call generated operations and use generated wire
  types through a stable client seam instead of adding paths or duplicating response interfaces.
- As a security-conscious operator, my API key stays in the `X-Api-Key` header, is never placed in a
  URL or serializable client state, and cannot appear in reflected errors or response-body messages.
- As an automation author, I continue to receive the established `LidarrError` codes and retry
  metadata needed by resilience and scheduler work in issues #195 and #196.

## Business Rules

### Client selection

1. A third-party SDK is eligible only when its current supported release installs, imports, builds,
   and executes on every runtime promised by rfmedia-cli. “Works despite an incompatible `engines`
   declaration” is not compatibility.
2. The selected solution must not add Bun as a runtime, build, test, or regeneration prerequisite.
3. It must support ESM with `moduleResolution: NodeNext`, strict TypeScript, `.js` import specifiers,
   and rfmedia-cli's declared Node floor.
4. Generated endpoint functions and generated wire types must be directly usable through a
   supported API. A dependency whose only supported surface is a hand-maintained endpoint wrapper
   fails the central maintenance requirement.
5. The transport must be injectable and instance-scoped so tests can run without a network and one
   client's origin or credential cannot reconfigure another client.
6. The client boundary must preserve origin pinning, header-only credentials, redirect rejection,
   request timeout and caller abort semantics, bounded success/error bodies, strict JSON handling,
   post-response delay, and credential-safe errors.
7. Failure must still map to the existing domain taxonomy: configuration/authentication,
   authorization, validation/not-found, rate-limited with `Retry-After`, timeout,
   invalid-response, metadata-provider-unavailable where applicable, and Lidarr-unreachable.
8. If TsArr fails any hard gate, local OpenAPI generation is the fallback without further scope
   negotiation. Current package evidence fails rules 1, 4, and 5, so local generation is the
   recommended implementation.

### Generated and hand-written boundaries

1. Generated files are machine-owned. They carry a generated header, are never edited manually,
   and are changed only by the regeneration workflow.
2. Generated operations own HTTP methods, endpoint paths, query/body serialization, and full wire
   DTO definitions. Production code outside the generated tree must not re-declare those details.
3. `LidarrClientApi` remains the action-facing capability contract. Its four current methods and
   `LidarrWantedQuery` defaults remain stable so actions and their typed mocks do not depend on a
   generator's naming or response envelope.
4. A repository-owned adapter may select generated operations, unwrap generated results, project
   them to stable domain types, perform runtime guards, and translate errors. It must not duplicate
   endpoint paths or define a parallel general-purpose SDK.
5. Generated wire types stay private to `src/lib/lidarr`. The public types in
   `src/types/lidarr.ts` remain intentionally narrow domain projections so a schema refresh does not
   silently alter CLI output contracts.
6. Type generation is not runtime validation. Existing malformed-response behavior must remain;
   generated TypeScript types do not justify removing guards for values used by commands.
7. The current user surface is unchanged. Therefore Bash, Zsh, and Fish completion templates should
   remain byte-for-byte unchanged, and their existing Lidarr parity tests must still pass. A codegen
   maintenance script is an npm workflow, not an `rfmedia` subcommand.

### Specification, regeneration, and drift

1. The repository pins the Lidarr OpenAPI document as a reviewed source artifact, with upstream URL,
   upstream commit or release identifier, retrieval date, and digest. Normal generation is offline
   from this snapshot.
2. The generator version and configuration are lockfile-pinned. Generation must be non-interactive,
   deterministic, and independent of a running Lidarr instance.
3. Generated output is checked in so normal package installation and runtime do not require network
   access or code generation.
4. “Regenerate” means snapshot + config + pinned generator -> generated tree. “Refresh” is a separate,
   explicit workflow that downloads a newer upstream snapshot, updates provenance, regenerates, and
   exposes the complete diff for review.
5. PR CI checks repository drift deterministically by regenerating from the checked-in snapshot in a
   clean temporary location and comparing it with the tracked generated tree. CI must not rewrite
   tracked files.
6. Upstream drift discovery is scheduled or manually invoked and reports a new snapshot/digest; it
   is not a nondeterministic merge gate that depends on Lidarr's develop branch or network
   availability.
7. Contract tests cover the operations actually consumed by rfmedia-cli. An upstream refresh is not
   accepted merely because code generation completes; typecheck, behavior, security, and error
   contracts must also pass.

### Compatibility behavior

- `getSystemStatus` continues to call the generated system-status operation and return the existing
  `LidarrSystemStatus` projection.
- `getHealth` continues to return validated health checks with the established severity union.
- `listArtists` continues to return the full artist list; filtering and pagination remain in the
  action layer.
- `getWantedMissing` continues to default to page `1`, page size `50`, sort key `releaseDate`, omit
  an unset sort direction, and return the existing page projection.
- The four commands remain read-only and `local-only`; code generation must not pull mutation,
  discovery, resilience, or scheduling behavior into this issue.

## Workflows

### TsArr decision spike

1. Record the candidate version, release date, engine declaration, exports, and dependency tree.
2. Test package installation under the supported Node line, ESM import under the repository's
   TypeScript settings, injected-fetch operation calls, concurrent client isolation, abort/timeout,
   and representative error responses.
3. Compare the supported API with the selection rules above. Record pass/fail per gate rather than a
   single informal “it ran” result.
4. Commit the decision record even when TsArr is rejected, so later maintainers know which evidence
   would need to change before reconsideration.

### Normal regeneration

1. Run the repository's Lidarr generation command from the pinned local snapshot.
2. Format generated output deterministically if the generator does not already do so.
3. Run the drift check; it must report clean immediately after regeneration.
4. Run focused generated-client contract tests, then rfmedia-cli typecheck, architecture checks,
   baseline Lidarr tests, build, and shell-completion template tests.
5. Commit the snapshot/config/generated changes together when they describe one upstream revision.

### Upstream refresh

1. Fetch the authoritative Lidarr v1 OpenAPI document from an explicit upstream commit or release,
   never an unrecorded moving URL.
2. Verify and record provenance and digest, then review the schema diff before generation.
3. Regenerate and inspect removed/renamed operations and changed required/nullability fields.
4. Update only domain projections required by current or separately approved feature scope.
5. Run the full contract suite. Breaking schema drift becomes an explicit reviewed change, not a
   silent generated-code update.

### CI drift and contract validation

1. Regenerate into a temporary directory from checked-in inputs.
2. Compare all expected generated files, including additions and deletions, and fail with the exact
   command maintainers must run.
3. Compile the generated client on Node 22 CI and execute mocked-fetch contracts for the four used
   operations.
4. Prove a changed snapshot or generator config without regenerated output fails, and prove a manual
   generated-file edit fails.
5. Run existing command/action/error tests unchanged to demonstrate behavioral compatibility.

## Domain Model

- **Candidate SDK**: A versioned third-party distribution evaluated against runtime, ownership,
  transport, and maintenance gates. TsArr is a candidate, not the domain contract.
- **OpenAPI snapshot**: The immutable, reviewed Lidarr API description used as generation input. Its
  provenance and digest are part of the artifact.
- **Generator configuration**: The pinned tool version, plugins, naming rules, client choice, and
  output path that make generation reproducible.
- **Generated client**: Machine-owned operation functions and wire DTOs. It knows Lidarr's HTTP
  schema but not rfmedia-cli command behavior.
- **Transport policy**: The instance-scoped fetch implementation and connection settings enforcing
  origin, authentication, redirect, timeout, size, delay, cancellation, and redaction rules.
- **Lidarr client facade**: The stable `LidarrClientApi` used by actions. It invokes generated
  operations and maps wire results/failures into domain contracts.
- **Domain projection**: The narrow `LidarrSystemStatus`, `LidarrArtist`, `LidarrWantedPage`, and
  `LidarrHealthCheck` shapes consumed by commands. These are deliberately independent of full
  generated resources.
- **Contract test**: An executable assertion connecting a generated operation to rfmedia-cli's
  required URL, headers, query, response projection, cancellation, or error semantics.
- **Generated-output drift**: Tracked generated files differ from output produced by the pinned
  snapshot/config/toolchain. This always fails CI.
- **Upstream-schema drift**: Lidarr's authoritative schema differs from the repository snapshot.
  This creates a reviewable refresh event but does not automatically change production code.

## Existing Codebase Integration

- `packages/rfmedia-cli/src/lib/lidarr/client.ts` is currently both the sole fetch owner and a
  four-endpoint hand-written client. It should become the stable facade/policy boundary over
  generated operations, retaining `LidarrClientApi` and behavioral defaults while removing literal
  endpoint ownership.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` owns origin-bound credentials, request settings, and
  runtime guards. Credential isolation and guards remain valuable; generated wire DTOs replace
  duplicated wire declarations only where they can do so without losing runtime validation.
- `packages/rfmedia-cli/src/types/lidarr.ts` is consumed by actions and test fixtures. Treat it as a
  stable domain/output contract, not as the destination for the complete generated schema.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts` resolves config and constructs the client. Its
  optional/required resolver behavior and typed configuration failures must remain unchanged.
- `packages/rfmedia-cli/src/actions/lidarr/*` and
  `src/actions/test-helpers/lidarr-client-mocks.ts` depend on the narrow client interface. They
  should require no endpoint or generated-type knowledge.
- `packages/rfmedia-cli/src/lib/lidarr/errors.ts` remains authoritative for user-visible failure
  semantics. Generator-specific exceptions and response envelopes must not leak through it.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` currently requires exactly one
  textual Lidarr `fetch` site in `client.ts`. The gate must be updated with the new transport
  ownership model without broadening permission for arbitrary production fetches or treating the
  generated tree as trusted application code.
- `packages/rfmedia-cli/package.json` and the root lockfile need pinned generation/drift scripts and
  dev dependencies. Generator engine requirements must agree with the repository's real Node floor;
  incompatible engine warnings are not an acceptable workflow.
- Existing `client.test.ts`, action tests, command tests, error tests, architecture tests, and
  `shell-completions/templates.spec.ts` provide the regression baseline. New tests should supplement,
  not replace, those behavioral assertions.
- The architecture/design record, regeneration instructions, and `ROADMAP.md` should record the
  TsArr decision, selected snapshot/toolchain, drift command, and #194 completion. No user-facing
  completion template update is required unless command flags are changed, which is outside scope.

## Success Criteria

1. A checked-in spike report evaluates TsArr against every selection gate on the supported Node
   line and records a reproducible local-generation decision with package/version evidence.
2. No Bun executable, dependency, or lockfile package is required by install, build, test,
   regeneration, or runtime workflows.
3. One documented command regenerates the Lidarr client from a pinned local spec, and a second
   deterministic check exits successfully only when tracked output matches the pinned inputs.
4. CI fails for both a manual edit to generated output and a snapshot/config change without
   regeneration; additions and deletions are detected.
5. The generated client typechecks, builds, and passes runtime import/operation smoke tests on Node
   22 under the repository's NodeNext ESM configuration.
6. Production endpoint paths, HTTP methods, query serialization, and wire DTOs for Lidarr are owned
   by generated output rather than parallel hand-written wrappers.
7. All existing Lidarr client, action, command, tier, error, and completion-template tests pass, with
   unchanged human/JSON command contracts and unchanged four-subcommand completion coverage.
8. Contract tests prove the four existing operations, wanted defaults, injected transport, origin
   pinning, header-only API key, redirect rejection, caller cancellation, timeout classification,
   response limits, malformed-response handling, HTTP taxonomy, `Retry-After`, and redaction.
9. Actions and commands import only the stable Lidarr client/domain boundaries; no generated type or
   operation leaks into the command layer.
10. The architecture check still rejects unauthorised production fetch calls and confirms the new
    instance-scoped Lidarr transport is the only authenticated Lidarr fetch owner.
11. Regeneration and upstream-refresh documentation includes source URL, upstream revision, digest,
    generator version, review steps, exact validation commands, and rollback by reverting the
    snapshot/generated change together.
12. `ROADMAP.md` marks #194 shipped only after the generated client, contracts, documentation, and
    CI drift gate are present; it must not imply that #195, #196, or mutation/discovery work shipped.

## Open Questions

- Is `>=22.0.0` an intentionally tested floor or shorthand for the maintained Node 22 release line?
  Current `@hey-api/openapi-ts` releases require a later Node 22 minor. The implementation must
  either select a generator compatible with the declared floor or explicitly raise and test the
  package engine; it must not silently narrow support.
- Which Lidarr upstream reference is the compatibility target: a named stable release, the version
  deployed by the maintainer, or a reviewed commit from `develop`? A moving `develop` URL alone is
  insufficient provenance.
- Should generation include the full Lidarr v1 API or an operation-filtered client? Full generation
  maximizes reuse for later issues but increases reviewed/packaged code; filtering reduces noise but
  can recreate per-endpoint maintenance if not configured declaratively.
- Can the chosen generated fetch client preserve bounded-body parsing through an injected fetch, or
  does the policy layer need a response-wrapping transport before generated deserialization?
- Should a live Lidarr smoke test be optional/manual or run in containerized CI? Mocked transport
  contracts are required either way; a live instance must not be the only proof of compatibility.
- What automated channel should announce upstream-schema drift (scheduled workflow artifact, issue,
  or dependency-style PR) without making ordinary PR CI depend on a moving upstream branch?
