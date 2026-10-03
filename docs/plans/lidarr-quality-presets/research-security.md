# Security Research — Lidarr Quality Presets

## Executive Summary

Issue #213 is safe to implement if quality profiles, custom formats, and naming remain behind the
existing Lidarr facade and hardened plan/apply boundary. The repository already provides strong
controls: final-request same-origin validation, header-only API-key injection, redirect rejection,
timeouts and bounded response bodies, sanitized typed errors, strict checksummed plans, private
atomic artifact storage, target-origin binding, explicit apply approval, dry-run isolation,
exclusive per-plan claims, live-state revalidation, sequential target admission, durable per-target
history, and explicit resume.

No critical vulnerability was found in the proposed feature. The release-blocking work is the
operation-specific safety model. These resources are shared configuration, not isolated artist
records: a custom-format change can affect every quality profile, a quality-profile write is a
complete replacement, and naming is a singleton policy for future imports and renames. The plan
must therefore seal the complete managed projection and dependency graph, retain unmanaged state,
use a lock scoped to the canonical Lidarr origin rather than only one plan ID, re-read immediately
before each write, verify immediately after it, and stop dependent writes on drift or uncertainty.

Configured presets and live schema responses are untrusted input. Dynamic custom-format fields must
be validated against both a local implementation/field allowlist and a fresh server schema.
User-supplied regular expressions need a deliberately restricted grammar because they are later
executed by Lidarr against release metadata. Naming templates need token, length, control-character,
and path-shape validation. Preset parsing also needs byte, depth, count, and expansion limits.

The current production dependency audit is a separate release concern. On 2026-07-25,
`npm audit --omit=dev --json` reported five vulnerable production packages, including direct
`js-yaml`, which is on the preset/config parsing path. The preset feature should not add a runtime
SDK or regex package; upgrade the affected parser and keep the pinned generated-client toolchain.

**Confidence**: High — based on the current transport, facade, configuration loader, error
taxonomy, generated-client checks, plan engine, apply workflow, scheduler/history behavior, pinned
OpenAPI snapshot, and the official Lidarr controller/service sources collected in
`research-external.md`, all reviewed 2026-07-25.

## Findings by Severity

### CRITICAL

No critical findings were identified, provided the implementation does not add direct mutation
commands, remote preset execution, a second HTTP/authentication owner, or an override that bypasses
origin, schema, checksum, drift, approval, or durable-history failures.

**Confidence**: High — the feature can be expressed entirely as bounded local data and
desired-state REST mutations through existing protected boundaries.

### WARNING

#### W1 — Shared configuration creates a larger blast radius than the entry count suggests

Custom formats participate in all quality profiles, quality-profile PUTs replace complete
definitions, and naming is singleton configuration. Counting only three named preset resources can
therefore conceal library-wide policy changes. Deleting or recreating a custom format is especially
dangerous because IDs and profile score associations can change.

Mitigation:

- Model `create`, `update`, `retain`, and `delete` separately for each resource and include all
  affected profile relationships in the plan summary.
- Make preset ownership additive by default. Never delete, reset, or rename an unmanaged custom
  format or profile because it is absent from a preset.
- Require a separate explicit prune intent, high-risk plan classification, full reference evidence,
  and confirmation for deletion. Do not include pruning in the first release unless rollback and
  reference handling are specified.
- Build every quality-profile PUT from a fresh complete server schema, merging all current custom
  formats exactly once and preserving unmanaged scores.

Alternative: limit v1 to create/update-only managed resources and naming overlay; defer all deletion
to a later operation with a dedicated plan type.

**Confidence**: High — confirmed by the current Lidarr quality-profile and custom-format services
linked from `research-external.md` and by the existing plan model's explicit risk/cascade contract.

#### W2 — A per-plan claim does not prevent two different plans from racing on the same resources

`acquireLidarrPlanClaim()` serializes reuse of one plan ID, but plans with different IDs can still
interleave writes to the same custom format, profile, or singleton naming row. Lidarr exposes no
documented ETag, revision, transaction, or idempotency-key field for these endpoints. A whole-plan
preflight alone is insufficient because state can change between preflight and a later write.

Mitigation:

- Acquire one exclusive configuration-apply lock keyed by canonical Lidarr origin before the final
  preflight and hold it through all terminal history writes.
- Re-read the exact resource immediately before each write and compare the managed and preserved
  projections to the sealed before-state.
- Re-read dependency catalogs after custom-format changes and rebuild profile payloads only from the
  sealed intent plus the newly observed, still-compatible state.
- Treat any third state as stale and require re-planning. Do not add a general `--force-stale` for
  shared configuration.

Alternative: use an external orchestrator lock if multiple hosts must administer the same Lidarr
instance; a local filesystem lock cannot coordinate across hosts.

**Confidence**: High — direct inspection of `plan-engine.ts` shows claim scope is the plan ID, while
the pinned OpenAPI has no conditional-write primitive for these resources.

#### W3 — Multi-resource apply is not transactional and can leave a partially converged policy

The required order is custom formats, refreshed IDs/schema, quality profiles, then naming. A crash,
timeout, validation rejection, or history failure between stages can leave earlier writes committed
and later writes unapplied. Blind rollback can be worse because it may overwrite concurrent changes
or fail to restore server-assigned IDs.

Mitigation:

- Persist a terminal or uncertain outcome after every individual resource mutation and before
  admitting its dependents.
- Verify the managed projection with a fresh GET after every successful response. A timeout or
  disconnect after dispatch is `uncertain`, not `failed`.
- Stop dependent admissions on stale, failed, uncertain, or non-durable outcomes. Resume must
  re-read first and classify each operation as `satisfied`, `ready`, or `drifted`.
- For uncertain POST creates, resolve by exact normalized name and full semantic definition before
  retrying; reject zero or multiple matches.
- Prefer forward reconciliation. Offer rollback only as a separately reviewed plan built from fresh
  state, never as an automatic catch block.

Alternative: split the workflow into separately approved stage plans. This reduces automatic
partial progression but increases operator effort and does not create server-side atomicity.

**Confidence**: High — the existing apply engine already models `uncertain`, durable history,
stop-admission behavior, and explicit resume; Lidarr supplies no cross-endpoint transaction.

#### W4 — Dynamic custom-format schemas and regular expressions are executable policy input

The OpenAPI types leave condition fields effectively untyped. A malicious or accidental preset can
supply unknown implementations, wrong field types, oversized values, duplicate conditions, or
expensive regex patterns. Lidarr later evaluates release-title and release-group regexes during
normal operation, so catastrophic backtracking can transfer denial-of-service impact from the CLI
to the server.

Mitigation:

- Accept only explicitly supported implementations and exact field names/types; currently these are
  release title/group regex, defined indexer flags, and bounded size ranges.
- Intersect the local allowlist with a freshly fetched server schema. Unknown implementations or
  schema disagreement must fail closed before planning, not pass arbitrary `Field.value` objects
  through the generated type.
- Bound condition count, regex byte length, total regex bytes, nesting, and preset expansion.
- Reject controls, bidirectional controls, backreferences, lookbehind, recursion-like constructs,
  nested ambiguous quantifiers, and other constructs outside a documented safe subset. Do not run
  untrusted expressions against attacker-controlled samples in the CLI process.
- Include exact condition order and normalized values in before/after state, checksum, diff, and
  post-write verification.

Alternative: initially support only repository-curated custom formats and require configured
presets to reference those names. This provides less flexibility but avoids accepting arbitrary
regex until a defensible grammar and compatibility suite exist.

**Confidence**: High for the untyped schema and execution path; Medium for any regex heuristic
because static detection cannot prove arbitrary backtracking regex safe.

#### W5 — Preset parsing and expansion need stricter bounds than ordinary configuration

The existing config loader limits file bytes and uses `yaml.CORE_SCHEMA`, but nested validators may
silently drop unknown keys and the installed `js-yaml` is currently vulnerable to alias/merge-key
complexity attacks. A preset can also expand a small declaration into many conditions, scores,
quality items, and plan entries.

Mitigation:

- Define a versioned, exact-key preset schema with no implicit defaults for destructive or
  ownership-changing behavior. Reject `__proto__`, `prototype`, `constructor`, sensitive keys,
  duplicate names, duplicate map keys, non-finite numbers, invalid enums, and unknown fields.
- Enforce limits before and after parsing: file bytes, YAML aliases, object depth, scalar length,
  resource count, conditions per format, quality-tree nodes/depth, scores per profile, naming-field
  length, and total expanded plan bytes/entries.
- Parse presets separately from general config; do not silently continue to another file after a
  malformed explicitly selected preset.
- Do not apply environment-secret interpolation to preset content. If non-secret substitution is
  later required, make variables explicit and allowlisted and keep resolved values within normal
  schema limits.
- Upgrade `js-yaml` to a fixed version and retain `CORE_SCHEMA`; JSON-only presets are a viable
  lower-complexity alternative.

Alternative: ship immutable JSON presets and allow user configuration only through typed CLI
overrides in the first release.

**Confidence**: High — direct inspection of `config.ts`, the 2026-07-25 audit, and the proposed
preset expansion model.

#### W6 — Naming templates can redirect filesystem layout and poison terminal output

Naming fields are server-interpreted path templates. Unexpected separators, traversal-like
literals, absolute-path forms, controls, bidirectional controls, or unsupported tokens can create
surprising future paths. The examples endpoint is preview-only and is not authoritative
validation. Echoing raw templates or examples can also inject terminal control sequences.

Mitigation:

- Allowlist documented naming tokens and persisted fields; reject legacy derived UI fields.
- Bound every template and literal segment; reject NUL/C0/C1 controls, bidi controls, absolute path
  syntax, `.`/`..` path segments, empty required formats, and platform-invalid separators.
- Require required title/track/artist tokens locally, then treat PUT plus fresh GET as authoritative.
  Examples may enrich review but must not authorize apply.
- Project and sanitize example responses as untrusted server data before human rendering.
- Seal both the complete fresh before-state and desired managed overlay. Preserve fields the preset
  does not own.

Alternative: provide only curated naming profiles with no free-form configured templates in v1.

**Confidence**: High for server-side template semantics and validation limits; Medium for
cross-platform path policy because Lidarr's host platform determines the final filesystem rules.

#### W7 — API-key possession grants broad Lidarr authority and must stay inside one transport

Lidarr's API-key contract does not provide resource- or verb-scoped credentials. The same key used
for reads authorizes shared-configuration writes. Any direct generated-client use, request logging,
credential-bearing URL, followed redirect, or serialized generated result would expand disclosure
and mutation risk.

Mitigation:

- Keep `client.ts` as the only importer of generated operations/types and `transport.ts` as the sole
  Fetch owner. Validate the final request before retrieving the key, inject only `X-Api-Key`, and
  preserve `redirect: "error"`.
- Never store the key, auth headers, raw requests/responses, generated result envelopes,
  environment values, or response bodies in presets, plans, history, diffs, errors, or output.
- Extend facade projectors and generated-contract tests for every new endpoint. Return only stable,
  bounded domain objects and fixed typed errors.
- Require interactive approval or `--yes` for real apply; machine output does not constitute
  authorization.

Alternative: operate a separate Lidarr instance/API key for automation if organizational isolation
is required; the current Lidarr API cannot express least privilege within one instance.

**Confidence**: High — direct inspection of `transport.ts`, `client.ts`, `errors.ts`, and the
official API-key authentication source linked from `research-external.md`.

#### W8 — Untrusted names, regexes, templates, and examples can escape review/output boundaries

Plan validation currently rejects terminal and bidi controls and bounds strings, but new preset and
wire projectors must apply the same rule before any table, warning, error, JSON/YAML, or CSV model is
built. CSV quoting alone does not neutralize spreadsheet formulas beginning with `=`, `+`, `-`, or
`@`. Large semantic diffs can also exhaust memory or make approval summaries misleading.

Mitigation:

- Validate at ingestion and use allowlisted output models; never rely only on renderer escaping.
- Bound display rows and field lengths while always reporting omitted counts and aggregate impact.
  `--verbose` must remain bounded by the plan limits.
- Keep machine data on stdout and diagnostics/human tables on stderr.
- Neutralize spreadsheet formulas in CSV display fields or explicitly label CSV as not
  spreadsheet-safe and recommend JSON for lossless automation. Test canary controls and formula
  prefixes in every format.
- Store stable error codes separately and do not include raw server validation bodies.

Alternative: omit CSV for this feature until a repository-wide spreadsheet-safe serialization
policy exists.

**Confidence**: High — the current validators protect existing plan strings, while the shared CSV
formatter only quotes values and does not neutralize formulas.

#### W9 — SHA-256 detects mutation but does not authenticate the preset or plan author

The current canonical checksum detects corruption and uncoordinated editing. A process able to
rewrite a plan can also recompute the checksum, and `createdBy` is only audit metadata. Curated pack
labels likewise do not prove provenance by themselves.

Mitigation:

- Preserve owner-only directories, mode `0600`, no-follow reads, file identity checks, atomic
  writes, canonical-origin matching, and expected plan ID/checksum pinning in automation.
- Include the preset identity/version/digest, complete before/after projections, dependency edges,
  preserved state, schema fingerprint, risk, cap, and operation ordering in checksum
  canonicalization.
- Never call the plain checksum a signature. If plans or packs cross user/host trust boundaries,
  introduce a signed version with an independently protected key and explicit trust roots.

Alternative: require presets to be local files owned by the current user and plans to be created and
applied on the same host; this matches the present single-user threat model without key management.

**Confidence**: High — this follows directly from the unkeyed `createHash("sha256")` implementation
in `plan-engine.ts`.

#### W10 — Current production dependencies include known denial-of-service vulnerabilities

The 2026-07-25 production audit reported one moderate and four high dependency entries:
`js-yaml`, `music-metadata`, `picomatch`, transitive `file-type`, and transitive `ws`. `js-yaml` is
directly relevant because configured presets are parser-controlled input. The other paths are not
required by this feature but remain in the same executable/package.

Mitigation:

- Upgrade `js-yaml` to at least `4.3.0`, `music-metadata` beyond `11.12.1`, `picomatch` to at least
  `4.0.4`, `file-type` beyond `21.3.1`, and `ws` to at least `8.21.0`, subject to lockfile and
  compatibility tests.
- Re-run `npm audit --omit=dev` and document any accepted unreachable residual.
- Add no new runtime parser, diff, regex, or Lidarr SDK dependency for issue #213.

Alternative: use JSON-only preset files until the YAML parser upgrade is released and verified.

**Confidence**: High — reproduced locally from the current lockfile on 2026-07-25. Advisory details:
[js-yaml](https://github.com/advisories/GHSA-52cp-r559-cp3m),
[music-metadata](https://github.com/advisories/GHSA-v6c2-xwv6-8xf7),
[picomatch](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj),
[file-type](https://github.com/advisories/GHSA-j47w-4g3g-c36v), and
[ws](https://github.com/advisories/GHSA-96hv-2xvq-fx4p).

#### W11 — Response byte limits do not bound semantic collection complexity

The transport caps a success body at 8 MiB and rejects invalid UTF-8, but a response within that
limit can still contain deeply nested quality groups, thousands of custom formats, oversized
dynamic field collections, or many naming examples. Recursive validation or canonical diffing can
consume disproportionate CPU and memory.

Mitigation:

- Add projector limits for collection length, string bytes, object keys, quality-tree depth and
  total nodes, specification fields/presets, and total normalized graph size.
- Use iterative traversal or explicit depth counters for recursive quality items.
- Reject server state that exceeds supported bounds as `invalid-response`; never truncate and then
  apply against an incomplete view.
- Keep apply sequential and use the existing scheduler budgets, request timeout, cancellation, and
  stop-admission behavior.

Alternative: make the feature read-only when live state exceeds supported bounds and provide a
diagnostic directing the operator to manage that instance directly.

**Confidence**: High — transport limits bytes, while generated recursive and dynamic models do not
provide semantic runtime bounds.

### ADVISORY

#### A1 — Command-line API-key overrides can leak through process inspection

`--lidarr-api-key` can remain in shell history and process arguments even though it is not logged by
the application.

Mitigation: prefer environment-backed config templates, dotenvx, or 1Password; document the CLI
option as a compatibility override and keep it out of examples. Alternative: remove the option in a
future breaking release after migration support exists.

**Confidence**: High — direct command/config inspection.

#### A2 — Non-TLS remote origins expose a bearer-equivalent credential

HTTP is reasonable for loopback or a trusted local container network, but a remote HTTP origin
exposes the API key and policy data in transit.

Mitigation: warn or require an explicit acknowledgement for non-loopback HTTP and recommend HTTPS
with normal certificate validation. Preserve same-origin validation and redirect rejection.
Alternative: allow HTTP only for loopback/private deployment classes defined by policy.

**Confidence**: High — standard bearer-secret transport behavior.

#### A3 — Plans and output contain private operational policy

Secret-free plans still contain internal origin, host/user/cwd, custom-format regexes, naming
templates, quality policy, resource IDs, and before/after state.

Mitigation: retain private plan/history permissions, document retention and sharing expectations,
and avoid embedding unnecessary raw schema/example data. Alternative: offer a separately generated
redacted review export that is never applyable.

**Confidence**: High — direct consequence of the reviewable artifact contract.

#### A4 — Curated preset updates are a supply-chain input

A compromised or accidentally changed bundled preset can alter release selection and future naming
across every installation that adopts it.

Mitigation: ship presets in the reviewed package/repository, version them, checksum their normalized
content, display version/digest in plans, and never auto-fetch or auto-apply updates. Alternative:
support only user-vendored local presets; if remote catalogs are later added, require pinned digests
and signature verification.

**Confidence**: High — preset content directly determines mutations.

#### A5 — Generated-client coverage must expand without widening the public boundary

The generated snapshot already contains the required endpoints, but the contract checker currently
enumerates only the operations used by existing features.

Mitigation: extend required endpoint/operation checks and architecture tests while leaving generated
files private and the exact generator version/lockfile/manifest checks intact. Alternative: add
narrow handwritten wire calls inside `client.ts`, but that duplicates generated endpoint ownership
and is less desirable.

**Confidence**: High — direct inspection of the generated SDK and generation script.

#### A6 — Dry-run must mean zero writes, not merely “do not save the final diff”

Schema reads and naming examples are GETs, but planning code may be tempted to create missing custom
formats to discover IDs or call PUT as validation.

Mitigation: prove dry-run/planning issues only GET requests and writes no history, queue, cache
authority, or plan-apply outcomes. Validate naming locally; the examples GET is optional review
data, not mutation validation. Alternative: omit examples from dry-run if its server behavior cannot
be pinned across supported versions.

**Confidence**: High — consistent with the existing global dry-run contract and current Lidarr API
semantics.

## Authentication and Authorization

| Classification | Security requirement                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WARNING W7     | Treat the configured Lidarr API key as full-instance mutation authority. Keep it off generated config objects and inside the final validated transport request only. |
| WARNING W2     | Bind authorization to the canonical Lidarr origin and serialize shared-configuration apply for that origin. A plan ID lock alone is not enough.                      |
| WARNING W9     | Treat `createdBy` and SHA-256 as audit/integrity data, not principal authentication. Pin reviewed plan ID and checksum in noninteractive automation.                 |
| ADVISORY A1    | Prefer environment/secret-manager acquisition over command-line key values.                                                                                          |
| ADVISORY A2    | Require protected transport for non-local origins.                                                                                                                   |

Real mutation requires explicit approval after the complete bounded impact summary. `--yes` skips
the prompt but not origin, schema, checksum, ownership, drift, lock, history, or verification gates.
No output format, curated label, or dry-run flag may implicitly grant mutation authority.

## Data Protection

| Classification | Security requirement                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| WARNING W7     | Persist allowlisted semantic state only; exclude API keys, headers, environment values, generated request/response objects, and raw error bodies. |
| WARNING W8     | Reject terminal/bidi controls before constructing any output model and define explicit CSV formula handling.                                      |
| WARNING W9     | Keep artifacts/history private, no-follow, identity-checked, bounded, and atomic.                                                                 |
| ADVISORY A3    | Handle plans as private operational data even though they are credential-free.                                                                    |

Config redaction already recursively masks names containing `token`, `password`, `apiKey`,
`secret`, or `plexToken`. Preserve it as defense in depth, but do not depend on name-based redaction
as the primary plan/output boundary. Plan serialization should use an allowlist that makes
secret-bearing values structurally impossible.

## Dependency Security

| Classification | Security requirement                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WARNING W10    | Resolve the current production audit findings, especially direct `js-yaml` on the preset path.                                                                |
| ADVISORY A4    | Version and checksum bundled curated presets; do not auto-fetch or auto-apply them.                                                                           |
| ADVISORY A5    | Preserve the immutable OpenAPI snapshot, exact `@hey-api/openapi-ts@0.93.0` pin, manifest integrity, local-reference check, and generated-output determinism. |

No third-party Lidarr SDK, schema validator, diff engine, or regex evaluator is required. Using the
existing generated SDK plus handwritten projectors preserves one authentication and supply-chain
boundary.

## Input Validation

| Classification | Security requirement                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| WARNING W4     | Validate dynamic implementations and fields against both local allowlists and fresh server schema; restrict regex grammar and size. |
| WARNING W5     | Apply exact versioned schemas and byte/depth/count/expansion bounds to preset files.                                                |
| WARNING W6     | Validate naming tokens, literals, paths, and required semantic tokens; treat examples as untrusted preview data.                    |
| WARNING W11    | Bound recursive and collection complexity in every wire projector; reject rather than truncate.                                     |

Resolve semantic resource names against fresh state with trim plus exact normalized comparison.
Reject duplicates and ambiguity; never choose the first server result. Plans should bind live numeric
IDs and human labels where IDs exist. New creates should bind a semantic definition digest and later
reconcile the server-assigned ID.

All numeric scores, flags, sizes, IDs, and thresholds must be finite safe values within explicit
operation-specific ranges. Quality items are ordered recursive policy, so canonicalization must
preserve meaningful order instead of sorting for convenience.

## Infrastructure Security

| Classification | Security requirement                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| WARNING W1     | Default to additive ownership and display global cascades explicitly.                  |
| WARNING W2     | Use an origin-scoped apply lock; coordinate externally for multi-host administration.  |
| WARNING W3     | Execute dependency stages sequentially, persist each outcome, and stop on uncertainty. |
| ADVISORY A2    | Protect remote connections with HTTPS and normal certificate verification.             |

This feature adds no listener, inbound service, shell command, or Docker privilege. CORS, CSRF, CSP,
session cookies, and shell injection are therefore out of scope unless a future HTTP/MCP wrapper or
external preset command is introduced. Such a wrapper would need independent authenticated
authorization and must not infer safety from local CLI approval.

## Secure Coding Guidelines

1. Keep commands and actions dependent only on stable handwritten domain types. Generated
   operations and wire types remain private to `client.ts`.
2. Make planning and dry-run read-only. Add negative tests asserting no POST, PUT, DELETE, history,
   or deferred-queue writes.
3. Represent each resource mutation as a strict discriminated operation with exact before/after
   state, dependencies, risk, idempotency identity, and verification projection.
4. Include all new fields in exact-key validation, canonicalization, checksum computation, history,
   resume matching, and human/machine presenters.
5. Acquire the origin-scoped lock, validate plan identity/origin/schema, perform full preflight, and
   then revalidate the exact resource immediately before dispatch.
6. After dispatch, classify response ambiguity conservatively and verify with a fresh GET. Never
   infer rollback from local cancellation.
7. Preserve unmanaged custom formats, scores, quality nodes, and naming fields in complete PUT
   payloads. Fail if preservation cannot be proven from fresh state.
8. Use iterative or depth-limited validation for recursive quality trees and explicit aggregate
   budgets for presets, plans, output, and HTTP projections.
9. Test hostile YAML aliases/merge keys, unknown dynamic fields, duplicate names, regex bombs,
   controls/bidi, path-like naming literals, CSV formulas, moving schemas, concurrent plans,
   uncertain creates, partial stage failure, and history-write failure.
10. Keep error messages fixed and bounded. Store safe codes and projections, never raw Lidarr
    bodies, generated envelopes, headers, or arbitrary causes.

## Trade-offs

- **Additive ownership versus exact synchronization:** retaining unmanaged resources prevents
  accidental policy loss but means the resulting instance is not a byte-for-byte mirror of the
  preset. Exact pruning should be a separate high-risk operation.
- **Fresh complete reads versus speed:** schema/catalog refreshes and per-resource revalidation add
  requests, but Lidarr has no conditional writes. Correct stale detection is worth the latency.
- **Origin-wide serialization versus throughput:** one configuration lock reduces parallelism but
  matches singleton/shared-resource semantics and makes history understandable.
- **Restricted regex versus compatibility:** a conservative grammar rejects some valid Lidarr
  expressions. Curated review or a future isolated validation service is safer than silently
  accepting patterns with unknown runtime cost.
- **Forward reconciliation versus rollback:** resume can safely converge known desired state;
  automatic rollback risks destroying concurrent edits and cannot reliably recreate original IDs.
- **Strict schema compatibility versus availability:** a new Lidarr condition implementation or
  changed schema will block configured preset apply until supported. Failing closed is appropriate
  for shared policy mutation.
- **Spreadsheet-safe CSV versus byte-faithful values:** prefix neutralization changes displayed CSV
  cells. JSON should remain the lossless automation format if CSV is hardened for spreadsheet use.

## Open Questions

1. Is first-release ownership strictly additive, or must pruning ship with issue #213?
2. Are configured presets allowed to define arbitrary custom-format regexes, or only select curated
   definitions?
3. What exact regex grammar, byte limit, and condition-count limit are supported?
4. What are the maximum preset bytes, YAML aliases, object depth, quality-tree depth/nodes, resource
   counts, and expanded plan entries?
5. Is the configuration lock local-only, or must multiple hosts coordinate through an external lock?
6. Should one plan contain all dependency stages, or should custom formats, profiles, and naming be
   separately approved stage plans?
7. Which naming fields are managed by omission versus explicitly reset, and are path separators
   ever allowed in configured literals?
8. Does CSV neutralize spreadsheet formulas, or is JSON the only supported lossless machine format
   for preset diffs?
9. Must `js-yaml` remediation block feature release, or will v1 accept JSON presets only?
10. What supported Lidarr version/schema fingerprint should a plan seal, and which schema changes
    require mandatory re-planning?
