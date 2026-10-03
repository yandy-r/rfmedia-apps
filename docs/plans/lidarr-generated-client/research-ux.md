## Executive Summary

Issue #194 is an internal transport replacement, so its successful UX is deliberate invisibility for
operators and a much clearer maintenance loop for contributors. The existing `rfmedia lidarr status`,
`list`, `wanted`, and `health` commands already establish the public contract: the same flags and
defaults, human tables on stderr, machine output on stdout, a non-zero exit code on failure, and
sanitized Lidarr-specific errors. Generated DTOs, operation names, and generator exceptions must not
escape that boundary.

The recommended experience is a locally generated client from a reviewed, pinned Lidarr OpenAPI
snapshot, kept behind the existing `LidarrClientApi` facade. Generation should be one deterministic,
offline command; verification should be a second read-only command used by CI. Updating the upstream
snapshot is a separate, explicit workflow because it changes the contract under review. This split
makes routine builds reproducible while still making upstream drift easy to inspect and recover from.

TsArr is attractive as a broad Servarr SDK, but the current published package creates a visible
compatibility cost: `tsarr@2.12.0` declares Node `>=24.16.0`, while rfmedia-cli declares Node `>=22.0.0`
and tests on Node 22. By contrast, `@hey-api/openapi-ts@0.99.0` can be confined to development-time
generation and declares Node `>=22.18.0`; committed generated output avoids imposing the generator on
operators. The spike should record this evidence and choose local generation unless a compatible,
pinned TsArr version satisfies the same runtime, security, and error contracts.

Shell completions should not change for this issue. They represent command names, flags, and accepted
values, none of which should change when the HTTP implementation changes. The existing bash, zsh, and
fish template tests should still run as a compatibility gate; editing templates without a CLI surface
change would create unnecessary reinstall churn for users.

## User Workflows

### Operator: run existing Lidarr commands

1. Configure `lidarr.baseUrl` and `lidarr.apiKey`, or pass `--lidarr-url` and
   `--lidarr-api-key`.
2. Run one of `rfmedia lidarr status`, `list`, `wanted`, or `health` with the same current flags.
3. Receive the same result shape and defaults:
   - `list` defaults to 50 artists and supports monitored, tag, quality-profile, limit, and offset
     filters.
   - `wanted` defaults to page 1, page size 50, and `releaseDate` sorting.
   - `health` preserves the current typed health filters.
   - machine modes preserve the `lidarr-status`, `lidarr-list`, `lidarr-wanted`, and
     `lidarr-health` envelopes.
4. On failure, receive one concise, credential-safe message and exit code 1. Operators should not see
   generated method names, schema component names, raw response bodies, stack traces, or generator
   package terminology.

This workflow is the primary compatibility criterion. Golden command tests should compare output
envelopes, human labels, defaults, request query serialization, and failure messages before and after
the transport replacement.

### Contributor: regenerate from the pinned snapshot

1. Install dependencies with the repository-supported Node version.
2. Run one documented workspace command, recommended as
   `npm run codegen:lidarr --workspace packages/rfmedia-cli`.
3. The command reads only the checked-in OpenAPI snapshot and pinned generator configuration. It does
   not download a moving upstream document.
4. The command replaces only machine-owned files under a clearly named `generated/` directory. Its
   final output reports the input snapshot identity, generator version, output directory, and number
   of generated files.
5. Run focused Lidarr tests and the verification command before committing.

Repeated generation from an unchanged checkout must produce no diff. Generated files should carry a
prominent machine-owned header pointing to the regeneration command so contributors do not attempt
manual repairs.

### Maintainer: refresh the upstream Lidarr contract

1. Choose an explicit Lidarr release tag or immutable commit, rather than a moving branch.
2. Run a separate update command that fetches that exact reference, records its source URL/ref and
   digest, validates that it is OpenAPI, and replaces the pinned snapshot.
3. Regenerate locally and review the schema diff separately from the generated-code diff where
   practical.
4. Adapt only the handwritten facade/projections where the reviewed API change requires it.
5. Run contract tests, current Lidarr command/action/error tests, typecheck, build, architecture checks,
   and completion-template tests.

Separating snapshot refresh from ordinary generation prevents an innocent build from silently
adopting a new API contract or failing because the network or upstream branch is unavailable.

### Reviewer: understand a generated-client pull request

The pull request should state the pinned Lidarr reference and generator version, summarize changed
operations or schemas, and distinguish machine-generated files from reviewed integration code.
Reviewers should be able to reproduce the output with one command and confirm zero drift with another.
Large generated diffs should not hide facade, error-translation, configuration, or public-type changes;
those handwritten changes should be called out explicitly.

### CI: report generated-code drift

CI should run an offline command such as
`npm run codegen:lidarr:check --workspace packages/rfmedia-cli`. On success it should print a short
confirmation naming the pinned input and generator version. On failure it should:

- say that committed generated output is stale, not merely that `git diff` failed;
- list changed, missing, and unexpected files within the generated boundary;
- print the exact local regeneration command;
- avoid dumping the full generated diff or any credential-bearing environment values;
- fail before expensive broad test jobs when job structure permits.

The check should generate into a temporary directory and compare normalized output, or otherwise
guarantee that a failed check does not leave a developer checkout dirty. CI must not contact Lidarr or
fetch a live upstream schema.

### Contributor: recover from a failed generation

If generation fails, the script should preserve the last known-good committed output. Generate into a
temporary directory, validate the expected file set and TypeScript parse/typecheck viability, then
replace the generated directory atomically. The error should identify the phase (`load spec`,
`validate`, `generate`, `format`, or `compare`) and a direct remedy. Typical recovery is:

1. confirm the supported Node and locked dependency versions;
2. reinstall with `npm ci` if the lockfile and installed generator differ;
3. rerun generation from the pinned snapshot;
4. if the snapshot was intentionally refreshed, inspect the schema change and update the facade or
   projections rather than editing generated files;
5. restore only the generated directory from version control if abandoning the refresh.

## UI/UX Best Practices

### Preserve the CLI as the stable interface

Generated code is a private implementation detail. Keep actions and commands dependent on the narrow
`LidarrClientApi` and domain projections, not generated DTOs. This prevents upstream optionality,
operation renames, and broad response types from changing table columns, machine schemas, mocks, or
consumer code. Existing lazy action imports should remain so startup does not eagerly load the full
generated surface.

The migration should preserve:

- all command names, descriptions, flags, conflicts, defaults, and accepted values;
- human output on stderr and machine data on stdout;
- existing empty-state copy such as `No artists match the criteria`, `No wanted albums on this page`,
  and `No health issues reported.`;
- current paging, filtering, and sorting semantics;
- exit code 1 for command failures;
- current public domain result shapes and action mocks.

### Make the maintenance commands self-explanatory

Use paired verbs with distinct intent: `codegen:lidarr` reproduces output from the pinned snapshot;
`codegen:lidarr:check` verifies it without changing tracked files. A networked snapshot update must
have a visibly different name and require an immutable `--ref`. Document all three next to the
generator configuration, not only in a distant contributor guide.

Console output should be compact in success cases and diagnostic in failure cases. Prefer:

```text
Lidarr client is up to date (spec v2.14.3, @hey-api/openapi-ts 0.99.0).
```

over raw generator logs. On drift, prefer:

```text
Generated Lidarr client is stale: 3 changed files, 1 missing file.
Run: npm run codegen:lidarr --workspace packages/rfmedia-cli
```

The exact version shown should come from locked configuration or package metadata, not duplicated
free-form documentation.

### Keep generated and handwritten ownership obvious

Put generated files in one directory, exclude that directory from manual architectural style rules
that the generator cannot satisfy, and continue applying strict lint/type/test rules to the facade.
Do not scatter generated DTOs into the public `src/types/lidarr.ts` module. A small checked-in manifest
can record the spec reference, digest, generator version, configuration, and selected operation set,
making a generated diff explainable without reading thousands of lines.

### Treat secrets and origins as interaction safety

The current client pins requests to one normalized origin, uses `X-Api-Key` headers, rejects
redirects, forbids authentication material in query parameters, bounds response bodies, and scrubs
messages. Generated defaults must not weaken these protections. Configuration must continue rejecting
URLs with embedded credentials, paths, queries, or fragments. Developer commands should never require
a real Lidarr API key; codegen and drift checks must be fully offline after the explicit snapshot
refresh step.

### Do not churn shell completions

The generated client adds no operator-facing command or option. Therefore bash, zsh, and fish templates
should remain byte-for-byte unchanged. Their existing Lidarr coverage should be included in validation
to prove that the migration did not accidentally alter the public CLI. If a later issue adds a command,
flag, or enum value, all three hand-maintained templates and their parity tests must change together.

## Error Handling

### Runtime translation boundary

Generated clients commonly expose transport-specific response or error objects. The facade must catch
those at one boundary and translate them into the existing `LidarrError` taxonomy. At minimum, preserve:

| Condition                                         | Operator behavior                                     | Structured behavior                                     |
| ------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Missing URL/API key                               | Explain config or CLI overrides                       | `configuration`, not retryable                          |
| Unsafe base URL                                   | `Invalid Lidarr base URL format`                      | `configuration`, not retryable                          |
| 401/403                                           | Authentication/authorization message with status      | configuration-class failure, not retryable              |
| 404/other 4xx                                     | Resource or unexpected-response message               | validation-class failure, not retryable                 |
| 429                                               | Rate-limited message; include safe delay when present | `rate-limited`, retryable, preserve `retryAfterSeconds` |
| 5xx/network/DNS                                   | Local Lidarr unreachable                              | `lidarr-unreachable`, retryable                         |
| Deadline exceeded                                 | Lidarr request timed out                              | `timeout`, retryable                                    |
| Malformed, wrong-shape, or oversized success body | Invalid/malformed Lidarr response                     | `invalid-response`, not retryable                       |
| Caller cancellation                               | Preserve caller abort rather than relabeling it       | caller abort reason                                     |

OpenAPI TypeScript output alone is not runtime validation. Keep explicit boundary validation or enable a
generated runtime-validation strategy that proves equivalent behavior. Otherwise a schema mismatch can
surface later as an opaque property-access error, which is worse for both operators and maintainers.

The translation layer must not attach or print raw generated error bodies, URLs containing secrets, or
unscrubbed fetch exceptions. It should retain the human operation labels (`lidarr system status`,
`lidarr health`, `lidarr list artists`, `lidarr wanted missing`) so failures remain recognizable.

### Code generation failures

Generation errors need a separate developer-facing taxonomy, even if implemented only as prefixed
messages and exit codes:

- unsupported Node/tool version: print required and detected versions;
- missing or digest-mismatched snapshot: name the expected local file and refresh command;
- invalid OpenAPI document: identify the first actionable validation path without flooding logs;
- generator/configuration failure: name the pinned generator and config file;
- nondeterministic output: report that a second generation differed and retain temporary paths in
  verbose mode only;
- output validation/typecheck failure: name the failing generated file and preserve the committed
  output;
- drift: list file-level differences and the exact regeneration command.

The normal generation path may replace generated files, but the check path should be observational and
leave the working tree unchanged. Neither path should auto-fetch a newer schema as a recovery action.

## Performance UX

Operator latency should remain effectively unchanged. The four commands issue the same number of
requests as today: status performs system-status and artist-list reads, while list, wanted, and health
perform their current single reads. A transport migration must not introduce discovery calls,
automatic retries, schema fetching, or pagination expansion; resilience belongs to issue #195.

Generated breadth can increase parse time, build time, and package size. Prefer operation-filtered
generation for the four current endpoints if it remains simple and deterministic, or ensure the facade
imports operation modules directly so bundling/runtime loading does not pull a monolithic SDK into CLI
startup. Measure cold `rfmedia --help` and one Lidarr command before accepting a material regression.

For contributors, the fast path should be local and incremental:

- a pinned local snapshot avoids network latency and outages;
- generator and formatting versions are locked by `package-lock.json`;
- drift checking scopes comparison to the generated directory and manifest;
- focused client/contract tests run before the full coverage suite;
- CI emits only a summary unless verbose diagnostics are requested.

Determinism is itself a performance feature: contributors should not spend time diagnosing diffs caused
by timestamps, source-machine paths, locale, line endings, or unstable schema ordering. Generated
headers must omit volatile timestamps, and output formatting must be part of the pinned pipeline.

## Competitive Analysis

| Approach                                           | Operator UX                                                                       | Maintainer UX                                                                                                                                         | Fit for rfmedia-cli                                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current handwritten client                         | Excellent control over messages, bounds, aborts, origins, and public domain types | Endpoint and wire guards require manual upkeep; architecture check assumes exactly one literal fetch site                                             | Useful compatibility baseline, but does not meet #194's regeneration goal                                                                                 |
| TsArr SDK                                          | Broad Servarr coverage and a convenient public client                             | Outsources generation and upstream tracking, but couples releases and runtime behavior to another package; current `2.12.0` requires Node `>=24.16.0` | Poor direct fit while rfmedia supports/tests Node 22; viable only if the spike proves a compatible pinned version and equivalent transport/error controls |
| Local `@hey-api/openapi-ts` generation             | Invisible when kept behind the facade                                             | Reproducible ownership of spec, configuration, diffs, and release timing; requires a small regeneration/check workflow                                | Best fit; current generator can be development-only and its committed output can support operators without a generator runtime dependency                 |
| Continue manual wrappers with generated types only | Little operator change                                                            | Reduces DTO typing work but preserves endpoint-path and serialization drift in handwritten code                                                       | Partial solution; does not satisfy the intent to stop hand-maintaining endpoint wrappers                                                                  |

TsArr demonstrates the ecosystem benefit of generated Servarr coverage, but its CLI, logging, error,
and release choices are not rfmedia's user contract. Importing only `tsarr/lidarr` reduces surface area,
yet the current Node-engine mismatch is decisive for the supported runtime unless the project raises its
minimum Node version as a separate, explicit decision.

Local OpenAPI generation adds repository-owned artifacts, but that ownership is beneficial here:
rfmedia can pin an upstream contract, retain its narrow domain model, preserve hardened transport
behavior, and update on a reviewed cadence. The generator itself should be treated like a compiler:
locked, invoked by scripts, quiet on success, and absent from operator concepts.

## Recommendations

1. Choose local OpenAPI generation after recording the TsArr compatibility spike. Do not raise
   rfmedia-cli's Node minimum solely to consume the current TsArr release within this issue.
2. Pin the Lidarr OpenAPI snapshot to an immutable release or commit and record its URL/ref and digest.
   Routine generation and CI verification must be offline.
3. Keep `LidarrClientApi`, public domain projections, action mocks, command outputs, defaults, and error
   taxonomy stable. Generated DTOs and operations remain private to `src/lib/lidarr`.
4. Configure generated operation functions to use an rfmedia-owned transport seam that preserves
   origin pinning, header-only authentication, redirect rejection, timeouts/cancellation, bounded
   bodies, sanitized errors, and delay behavior. Avoid handwritten endpoint-path wrappers.
5. Add deterministic package scripts with clear intent: a mutating `codegen:lidarr`, an observational
   `codegen:lidarr:check`, and a separately documented networked snapshot-update command requiring an
   immutable ref.
6. Generate into a temporary directory, validate, then replace machine-owned output. Never leave a
   half-generated tree after failure.
7. Make CI drift feedback actionable: summarize file changes, print the regeneration command, and keep
   the check offline and side-effect-free. Place it early enough to avoid wasting the full test budget.
8. Add contract tests for generated method/path/query/header behavior and facade mapping tests for
   every current error class, response guard, abort path, and default. Retain current command/action
   tests as operator-compatibility evidence.
9. Keep the existing shell completion templates unchanged. Run their bash/zsh/fish parity tests and
   document that no completion reinstall is required for this release.
10. Document the generated directory as machine-owned and provide a short contributor workflow beside
    the generator configuration. The pull request should clearly separate snapshot, generated, and
    handwritten integration diffs.

## Open Questions

- Which immutable Lidarr release or commit is the initial compatibility target, and where will the
  repository store its source URL/ref and digest?
- Does Lidarr publish one authoritative OpenAPI artifact suitable for pinning, or must the update script
  normalize/build it from upstream source?
- Should generation include only the four current read operations or the full v1 API? Operation
  filtering improves review and startup ergonomics, while full generation may reduce churn for the
  upcoming mutation/discovery issues.
- Which custom transport hook or generated client configuration best preserves strict body limits,
  redirect rejection, caller abort semantics, and sanitized errors without reintroducing handwritten
  endpoint wrappers?
- Will runtime response validation remain as narrow handwritten domain guards, or be generated from the
  OpenAPI schema? Whichever choice is made needs malformed-response contract tests.
- Should drift verification compare a temporary generated tree byte-for-byte, or regenerate the tracked
  tree and rely on `git diff --exit-code`? The former provides the safer unchanged-worktree experience.
- Should the snapshot-update workflow be a local maintainer command only, or a manually dispatched bot
  pull request? It should not be a network-dependent merge gate either way.
- Is a supported Node minimum of exactly `22.0.0` intentional, given the current generator requires
  Node `>=22.18.0`? Keeping the generator development-only reduces operator impact but contributors and
  CI still need an explicit codegen toolchain version.
- Does the architecture audit need a new rule based on allowed transport imports rather than exactly one
  textual `fetch` call in `client.ts` once generated operations own request construction?
- What performance threshold should block the migration for CLI startup, built artifact size, and
  generation/check duration?
