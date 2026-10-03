# Security Research — Lidarr Cascade Analysis and Budget Estimation

## Executive Summary

Issue #219 can be implemented without expanding the network or credential attack surface. The
recommended design computes cascade estimates deterministically from the already reviewed plan,
operation policy, and bounded static budget configuration. It does not contact Prowlarr, indexers,
download clients, or new Lidarr endpoints.

The existing Lidarr plan boundary is strong: artifacts use exact-key validators, canonical SHA-256
checksums, bounded reads, private permissions, no-follow file access, origin binding, sensitive-key
rejection, terminal-control rejection, and machine-output isolation. The implementation must extend
all of those invariants to the new analysis. The two critical design gates are:

1. cascade data must be strict, canonical checksum material rather than untrusted display metadata;
2. neither Lidarr nor possible future Prowlarr credentials may enter plan artifacts, output, or
   estimation inputs.

No new dependency is required. A small pure analysis module plus explicit validators is safer than
adding a Prowlarr SDK or live-capacity integration.

## Findings and Required Mitigations

### CRITICAL — SEC-01: Unsealed analysis would make the reviewed plan misleading

If warnings, assumptions, budgets, or quantities are appended only at presentation time, an
operator may approve information that is not bound to the artifact later applied. If new fields are
accepted without exact validation, a modified artifact could also display fabricated safety
claims.

Mitigations:

- Make the complete cascade analysis canonical checksum material.
- Extend the exact-key parser for every new object and reject unknown keys.
- Validate the analysis before verifying the checksum so malformed data fails with the typed plan
  validation contract.
- Recompute expected analysis from sealed plan facts during validation where practical; otherwise
  validate all arithmetic relationships, warning states, and operation-specific invariants.
- Either introduce a new plan version for analysis-bearing artifacts or explicitly support an
  optional analysis field in v2 while preserving exact canonicalization of legacy v2 artifacts.
  Never silently reinterpret old artifacts as if analysis was reviewed.
- Apply must use the sealed analysis. It must not replace it with current config values.

### CRITICAL — SEC-02: Prowlarr or Lidarr credentials must never enter artifacts

Static per-plan budgets do not require Prowlarr access. Adding a live Prowlarr call would create a
new privileged credential, network boundary, SSRF/cross-origin risk, secret-redaction burden, and
failure mode unrelated to the core feature. Raw config, provider responses, headers, or URLs may
also contain secrets that the current sensitive-key check cannot detect when embedded inside an
innocently named string.

Mitigations:

- Implement issue #219 with static numeric budgets only; do not add Prowlarr credentials or calls.
- Store only numeric allowance, unit, horizon, comparison state, and stable provenance such as
  `configured-per-plan`. Never persist a config object or raw provider response.
- Continue resolving the Lidarr credential only through the existing origin-bound provider and
  transport. Cascade analysis receives the credential-free plan/domain projection only.
- Never copy CLI `--lidarr-api-key`, config `lidarr.apiKey`, environment values, request headers, or
  exception causes into analysis, recommendations, or machine output.
- If live Prowlarr usage is designed later, use a separate origin-bound credential provider with
  canonical HTTP(S) origin validation, header-only authentication, redirects disabled, bounded
  bodies, timeouts, response projection, and error redaction. That requires a separate security
  review.

### WARNING — SEC-03: Analysis input and arithmetic need fail-closed bounds

Counts and multipliers are untrusted when read from an artifact or config. Negative values,
floating point values, unsafe integers, excessive arrays, divide-by-zero, or multiplication beyond
`Number.MAX_SAFE_INTEGER` could create false budget states or resource exhaustion.

Mitigations:

- Accept only bounded non-negative safe integers for quantities and positive safe integers for
  configured allowances.
- Prefer exact plan counts. For multiplication, check operands and overflow before calculating.
- Do not accept user-provided ratios; derive them using integer comparisons such as
  `estimate * 2 <= allowance`, with overflow-safe ordering or division.
- Bound metric, warning, assumption, and recommendation arrays and all strings.
- Validate cross-field invariants: changed scope equals plan review facts; `none` implies exact zero;
  `unknown` has no numeric quantity; budget state matches quantity and allowance; warning codes
  match the derived comparison.

### WARNING — SEC-04: Remote or configured text can manipulate terminal output

Lidarr names and config-derived labels are untrusted display data. Control and bidirectional
characters can rewrite prompts or conceal warning text. New cascade presentation must not bypass
the existing terminal-safe plan validator.

Mitigations:

- Use enums and generated constant prose for metric codes, basis codes, warnings, and
  recommendations.
- Pass every stored string through the existing bounded terminal-control validator.
- Do not interpolate raw Lidarr/Prowlarr response text, indexer errors, or config labels into
  warnings.
- Keep approval prompts based on strict plan facts, not display strings.
- Preserve the plan-path terminal-control checks for all new or reused plan commands.

### WARNING — SEC-05: Machine output must remain isolated and secret-free

Direct `console.error` calls or progress rendering in JSON/YAML/CSV mode can corrupt automation.
Flattening structured analysis into CSV may also lose certainty or warning semantics. CSV strings
opened in spreadsheet software can be interpreted as formulas when they begin with `=`, `+`, `-`,
or `@`.

Mitigations:

- Route cascade output through the existing `isMachineFormat` and formatter boundary.
- Emit one stable structured analysis object in JSON/YAML. Do not require consumers to parse human
  `risk.cascade` prose.
- Define an explicit flat CSV projection containing aggregate numeric fields, certainty, horizon,
  budget state, and highest warning severity.
- Keep CSV cascade values to enums, booleans, and numbers where possible. If arbitrary strings are
  added, harden the shared CSV serializer against formula injection or omit those fields from CSV.
- Add one parity test proving no human cascade text contaminates stdout in each machine format.

### WARNING — SEC-06: A static allowance is not live remaining capacity

Calling a configured number “remaining Prowlarr budget” would be a security and operational
integrity error. Shared indexers can be consumed by other applications between plan and apply, and
an unauthenticated estimate cannot prove provider state.

Mitigations:

- Name the value `configured allowance` or `per-plan budget`, not remaining capacity or quota.
- Seal the budget snapshot and provenance into the plan.
- Use explicit `unconfigured` and `unknown` states; never convert either to unlimited or zero.
- Keep warnings advisory for this issue. A warning must not silently truncate entries, alter
  ordering, or bypass existing apply authorization.
- If hard enforcement is introduced later, revalidate authoritative usage immediately before the
  first mutation and define an explicit, audited override authorization.

### WARNING — SEC-07: Budget warnings must not weaken destructive authorization

Cascade severity and existing mutation risk are different controls. A low query estimate does not
make artist, album, or file deletion safe, while an exceeded advisory budget does not authorize a
different cohort or execution policy.

Mitigations:

- Preserve the existing checksum, expected plan ID/checksum, target-origin, drift, exclusive claim,
  resume, and destructive confirmation gates unchanged.
- Render cascade warnings alongside, not instead of, `risk.level`, `risk.destructive`, and exact
  deletion evidence.
- Ensure recommendations never synthesize a force/override flag or executable command that omits
  existing destructive authorization.
- Applying a plan must execute exactly the sealed entries even when current budget config differs.

### ADVISORY — SEC-08: SHA-256 provides integrity, not author authenticity

An attacker who can replace a private plan file can recompute its unkeyed checksum. The existing
private directory/file permissions and no-follow I/O substantially reduce local tampering risk, and
the expected ID/checksum handoff detects substitution when the operator pins a trusted digest.

Mitigations:

- Continue displaying and accepting the expected plan ID and checksum at apply.
- Do not describe the checksum as a signature or proof of author identity.
- Keep analysis inside the same private artifact rather than a sidecar file.
- HMAC/signature support is unnecessary for the current single-user local threat model; reconsider
  it only for shared artifact distribution.

### ADVISORY — SEC-09: Avoid unnecessary dependency and network expansion

A new SDK, schema library, or Prowlarr client would increase supply-chain and maintenance risk for
deterministic arithmetic already expressible with project primitives.

Implement analysis as pure TypeScript with existing types and validators, reuse only the existing
checksum engine, keep generated Lidarr modules private, and leave codegen/OpenAPI unchanged.

### ADVISORY — SEC-10: Minimize operational metadata in the artifact

Plans already contain host, user, working directory, target origin, and library names. Cascade
analysis could unnecessarily add indexer identities, internal URLs, raw usage history, or provider
topology, increasing disclosure if an artifact is shared.

Persist only aggregate review facts; exclude provider hosts, indexer names, API routes, raw
responses, and download-client details. Document plans as private operational data.

## Configuration Requirements

- Place cascade budgets under a dedicated allowlisted Lidarr planning section, not scheduler
  `operationBudget`; the units and security meaning differ.
- Support separate optional positive integer allowances for indexer query units and acquisition
  candidates.
- Missing values mean `unconfigured`.
- Reject unknown config keys, floats, zero, negatives, unsafe integers, control characters, and
  secret-looking keys inside the cascade section.
- Secret templates remain available to the overall config loader, but cascade configuration should
  contain no secret field and should never require one.
- Do not log the complete loaded config when reporting validation errors.

## Dependency Security

**ADVISORY — SEC-09:** Add no SDK, schema package, or Prowlarr client for deterministic arithmetic.
Use pure TypeScript, existing validators, and the existing checksum engine; keep generated Lidarr
modules private and leave codegen/OpenAPI inputs unchanged.

## Required Security Tests

Keep coverage contract-focused:

1. one validator matrix for unknown keys, sensitive keys, unsafe integers, terminal controls, and
   contradictory metric/budget states;
2. one checksum test proving any analysis mutation is rejected;
3. one legacy artifact test proving valid v1/v2 plans remain readable with analysis reported as
   `not-recorded`;
4. one secret non-disclosure test covering plan JSON, human output, JSON/YAML/CSV, and failure
   output;
5. one operation matrix proving local-only operations and `searchForMissingAlbums: false` produce
   exact zero immediate query impact without network calls;
6. one machine-output parity test showing warnings are structured and human logging is suppressed.

No separate test is needed for every recommendation sentence; stable enum/code derivation and the
validator matrix cover that contract.

## Security Trade-offs

- Static budgets are less current than a live Prowlarr query, but they are deterministic,
  auditable, credential-free, and available when the stack is degraded.
- Advisory warnings cannot prevent an operator from applying a high-impact plan, but hard blocking
  would require new override authorization and reliable current-usage evidence. Advisory behavior
  is the correct scope for issue #219.
- A new plan version has migration cost, while an optional sealed v2 field adds compatibility
  complexity. Either is safe only if legacy absence is explicit and canonicalization is exact; a
  version increment is easier to reason about.

## Open Security Decisions

- **WARNING:** Decide whether analysis-bearing artifacts use v3 or an explicitly optional sealed v2
  field. Recommendation: v3 if every plan family can migrate together; otherwise optional v2 with
  exhaustive legacy/canonicalization tests.
- **WARNING:** Decide whether CSV supports only aggregate analysis. Recommendation: yes; omit free
  text and nested warning detail.
- **ADVISORY:** Decide whether `unconfigured` creates a warning or informational advisory.
  Recommendation: stable advisory code, not an apply blocker.
- **ADVISORY:** Decide whether shared/multi-user plan exchange is supported. Recommendation: keep
  the present single-user local threat model and document that checksums are not signatures.

## Security Acceptance Gate

Issue #219 is security-ready when analysis is deterministic and credential-free; every new field is
bounded, exact-key validated, terminal-safe, canonicalized, and checksummed; legacy artifacts have
an explicit `not-recorded` state; machine formats remain clean; no new network call or dependency is
introduced; and all existing apply authorization and private artifact protections remain intact.
