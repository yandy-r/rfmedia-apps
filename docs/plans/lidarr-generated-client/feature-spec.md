# Feature Spec: Lidarr Generated Client

## Executive Summary

Issue #194 replaces rfmedia-cli's temporary handwritten Lidarr endpoint bindings with a locally
generated, committed SDK while preserving the four shipped commands and their security behavior.
Current TsArr is rejected because its supported Node floor excludes Node 22 and its shared client
failed multi-instance isolation. A private NodeNext Fetch SDK will be generated from an immutable
official Lidarr OpenAPI snapshot, behind the existing `LidarrClientApi` facade. Deterministic offline
drift checks, strict runtime projections, exact origin/credential confinement, and bounded response
parsing are merge requirements.

## External Dependencies

### APIs and Services

- **Lidarr API v1**: use the
  [official OpenAPI document](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json)
  pinned at commit `3e2858439ff35b372d0af00bcea1b0a357572d26`.
- **Authentication**: `X-Api-Key` header only; never use the documented query-key alternative.
- **Consumed operations**: system status, health, artist list, and wanted/missing.
- **Network model**: ordinary generation, build, test, and CI use the checked-in snapshot and never
  contact GitHub or a live Lidarr instance.

### Libraries and SDKs

| Library                 | Version                           | Purpose                                              |
| ----------------------- | --------------------------------- | ---------------------------------------------------- |
| `@hey-api/openapi-ts`   | Exact `0.93.0` candidate          | Development-only NodeNext SDK generation             |
| Generated Fetch runtime | Exact version proven by the spike | Per-instance private runtime client                  |
| Node Fetch APIs         | Node 22+                          | Secure transport policy without another HTTP library |

TsArr remains a reference only. If the verified Hey API pair cannot support `.js` NodeNext imports,
per-instance clients, injected Fetch, and bounded responses, use `openapi-typescript` plus
`openapi-fetch` as the first fallback.

## Business Requirements

### User Stories

- As an operator, I want `lidarr status`, `list`, `wanted`, and `health` to retain their flags,
  defaults, output, and errors.
- As a Node 22 user, I want install and runtime to remain Node-only without Bun or Node 24.
- As a maintainer, I want one offline regeneration command and one non-mutating drift check.
- As a reviewer, I want snapshot, generated, and handwritten policy diffs clearly separated.
- As a future Lidarr contributor, I want generated operations and models without generator types
  leaking into commands.

### Business Rules

1. Generated code owns endpoint paths, HTTP verbs, query serialization, and full wire DTOs.
2. Handwritten policy owns final-origin checks, header-only credentials, redirect rejection,
   timeout/cancellation, body limits, strict decoding, projections, and error translation.
3. `LidarrClientApi`, command output, wanted defaults, error taxonomy, and reliability tiers remain
   source- and behavior-compatible.
4. Generated modules stay private; only the Lidarr facade may import them.
5. The same pinned snapshot, manifest, config, versions, and lockfile produce byte-identical output
   offline. Check mode detects changed, missing, extra, and symlink entries without dirtying the tree.
6. Upstream refresh is a separate immutable-ref command, never part of install/build/typecheck/PR CI.
7. Bash, Zsh, and Fish templates remain unchanged because the CLI surface does not change.
8. Retain GPL-3.0 source attribution for the spec and inspect packed contents. This issue performs no
   npm publish; future publication requires explicit maintainer approval of license treatment.

### Edge Cases

| Scenario                                             | Expected Behavior                                        |
| ---------------------------------------------------- | -------------------------------------------------------- |
| Two clients with different origins/keys              | Requests remain isolated                                 |
| Generated request supplies query/header auth         | Reject before credential retrieval/network               |
| Redirect                                             | Reject rather than forward credentials                   |
| Oversized, stalled, invalid UTF-8, or malformed body | Cancel/timeout or `invalid-response` with no raw leakage |
| Snapshot/config changes without generated output     | Offline drift check fails with repair command            |

### Success Criteria

- [ ] A decision record captures TsArr engine metadata, Node 22 smoke success, redirect/result shape,
      and failed two-client isolation.
- [ ] The full official snapshot, immutable manifest, exact generator/runtime pins, config, and
      private generated SDK are committed.
- [ ] No handwritten production code owns Lidarr endpoint paths, verbs, or generic query assembly.
- [ ] Credential/origin confinement and bounded pre-parse responses have adversarial regression tests.
- [ ] Node 22 typecheck, tests, coverage, build, deterministic drift, architecture, and pack checks pass.
- [ ] Existing action/command/error/tier and all-shell completion tests pass without surface changes.
- [ ] `ROADMAP.md` marks only #194 shipped; later Lidarr issues stay open.

## Technical Specifications

### Architecture Overview

The dependency flow is: `commands -> actions -> LidarrClientApi -> generated operations -> hardened
transport -> Lidarr API`. Stable domain projections and `errors.ts` sit beside the facade. The full
OpenAPI snapshot plus manifest/config feed offline write/check scripts that own
`src/lib/lidarr/generated/`. There is no database, migration, daemon, inbound API, or new CLI command.

### Data Models

The versioned manifest records the allowlisted `Lidarr/Lidarr` repository, full commit, exact source
path and commit-pinned URL, Git blob SHA, exact-byte SHA-256, exact generator/runtime versions, and
config version. It excludes timestamps and machine-specific values.

`LidarrSystemStatus`, `LidarrHealthCheck`, `LidarrArtist`, and `LidarrWantedPage` remain stable domain
projections. Generated models remain private untrusted wire shapes. Focused validators construct new
domain objects and reject missing/wrong required fields, invalid enums, non-finite numbers, malformed
arrays, and nested-record errors.

### API Design

Keep the current four-method `LidarrClientApi`. `getWantedMissing()` retains `page=1`,
`pageSize=50`, `sortKey=releaseDate`, and omission of unset `sortDirection`; it does not begin sending
`includeArtist`, `monitored`, or other generated options.

Create one generated-client-compatible Fetch closure per `LidarrClient`. It validates the final URL,
rejects pre-existing auth, retrieves the origin-bound key at the final safe moment, injects one
`X-Api-Key`, and forces `redirect: "error"`. It keeps caller abort/timeout active while streaming at
most 8 MiB success or 4 KiB error content, uses fatal UTF-8 decoding, and returns only a bounded
reconstructed `Response` to the generated parser.

### System Integration

Create the snapshot/manifest, generation config, write/check script, immutable-ref refresh script,
private generated tree, `transport.ts`, and focused script/transport/generated-contract tests. Modify
`client.ts`, connection/guard documentation, the existing architecture scanner and tests,
`package.json`/lockfile, rfmedia CI, maintenance documentation, attribution, and `ROADMAP.md`.

Production endpoint calls migrate to named generated operations. Remove the generic handwritten
`request()` and `LidarrRequest` escape hatch. Extend the existing scanner so `transport.ts` is the
sole Lidarr Fetch owner and only `client.ts` imports the generated tree.

## UX Considerations

### User Workflows

- **Operator**: runs the same four commands and receives identical human/machine output and sanitized
  typed failures; generated names, envelopes, requests, responses, and bodies never escape.
- **Maintainer**: regenerates offline from the pinned snapshot, reviews generated versus handwritten
  diffs, and runs a read-only drift check.
- **Upstream refresh**: selects an immutable commit, validates provenance/local-only references and
  required operations/security schemes, regenerates, then reviews the schema change explicitly.
- **Recovery**: a failed generator reports its phase and repair command while preserving the last
  known-good tracked tree; generated files are never manually repaired.

### UI Patterns

| Surface          | Pattern                                                        |
| ---------------- | -------------------------------------------------------------- |
| Runtime CLI      | Invisible implementation replacement                           |
| Codegen success  | One-line pinned commit/version/file-count summary              |
| Drift failure    | Relative changed/missing/extra files plus exact repair command |
| Generated source | Machine-owned header pointing to regeneration                  |

### Performance UX

No command adds requests or retries. Record generated/tracked/packed size, typecheck duration, and
cold help startup. Generate the full SDK initially; add deterministic filtering only after a measured
material regression. Existing shell templates remain byte-for-byte unchanged and their parity tests
prove that no completion update is required.

## Recommendations

### Implementation Approach

1. Record the TsArr rejection and verify/exact-pin the Hey API generator/runtime pair.
2. Add the full snapshot, provenance manifest, config, deterministic write/check/refresh scripts, and
   generated SDK.
3. Extract the existing secure request policy into `transport.ts` and prove the two CRITICAL controls.
4. Migrate the four facade methods to generated operations, retain focused projections, and remove
   generic manual requests.
5. Enforce imports/fetch ownership, add the offline CI drift gate, run full compatibility tests, write
   maintenance/attribution docs, and update the roadmap.

### Technology Decisions

| Decision           | Choice                               | Rationale                                                 |
| ------------------ | ------------------------------------ | --------------------------------------------------------- |
| Runtime SDK        | Local generated client               | TsArr engine and isolation failures                       |
| Spec scope         | Full immutable upstream snapshot/SDK | Avoid a second manual allowlist before cost evidence      |
| Runtime validation | Existing focused projectors          | Strict safety for four consumed shapes                    |
| HTTP policy        | One custom Fetch closure             | Preserve application trust rules without manual endpoints |
| Drift              | Fresh-temp recursive byte comparison | Non-mutating and complete                                 |
| Refresh            | Manual immutable-ref command         | Deterministic ordinary CI and least privilege             |
| Completions        | No edits                             | No command/flag/enum changes                              |

## Risk Assessment

### Technical Risks

| Risk                                  | Impact   | Mitigation                                                       |
| ------------------------------------- | -------- | ---------------------------------------------------------------- |
| Credential/origin leakage             | Critical | Final-fetch validation/injection and interleaved-client tests    |
| Unbounded generated parsing           | Critical | Bounded strict stream read before generated parse                |
| Compile-time types trusted at runtime | High     | `unknown`-to-domain focused validators                           |
| Incomplete drift assurance            | High     | Full entry/type/byte comparison in a fresh directory             |
| Untrusted spec/toolchain              | High     | Immutable allowlist, local-only refs, exact pins, reviewed diffs |
| GPL-labelled snapshot publication     | High     | Attribution, tarball inspection, no publish without approval     |
| Generated naming/size churn           | Medium   | Private facade, exact pins, measurements                         |

### Security Considerations

#### Critical — Hard Stops

- **SEC-194-01**: the key exists only in the private provider/final transport; exact origin,
  header-only auth, redirect rejection, and two-client isolation must be tested.
- **SEC-194-02**: generated code never parses an unbounded body; chunked/misleading/stalled/invalid
  response tests must prove caps and cancellation through body consumption.

Warnings requiring direct evidence include runtime shape validation, private unwrapping of generated
request/response/error envelopes, allowlisted local-ref-only snapshot refresh, exact supply-chain
pins, full-tree drift comparison, path-confined output replacement, and approved attribution.

## Task Breakdown Preview

### Phase 1: Decision, provenance, and codegen

Record the spike, verify/pin the generator/runtime, add the full snapshot/manifest/config, and prove
deterministic NodeNext output with script tests.

### Phase 2: Secure transport and facade migration

After the generated call shape is known, extract/test the hardened transport, migrate four facade
methods, preserve defaults/projectors/errors, remove generic requests, and prove client isolation.

### Phase 3: Enforcement and compatibility evidence

Extend architecture/CI drift gates; run focused and full validation, unchanged completion parity,
build and pack inspection; document regeneration/refresh/rollback/attribution; update `ROADMAP.md`.

## Decisions Needed

Resolved for #194: use local generation; pin initial upstream commit
`3e2858439ff35b372d0af00bcea1b0a357572d26`; generate the full private SDK; keep the Node 22 runtime
floor and manual immutable-ref refresh; preserve completions unchanged; add attribution and perform no
npm publish without separate approval. No child issue is required unless a later bot, live-container
test, publication decision, or measured filtering optimization needs separate ownership.

## Research References

- [research-external.md](./research-external.md): API and tool evidence.
- [research-business.md](./research-business.md): requirements and compatibility rules.
- [research-technical.md](./research-technical.md): architecture and files.
- [research-ux.md](./research-ux.md): operator/maintainer workflows.
- [research-security.md](./research-security.md): severity-classified trust boundaries.
- [research-practices.md](./research-practices.md): reuse, KISS, and tests.
- [research-recommendations.md](./research-recommendations.md): consolidated alternatives and risks.
