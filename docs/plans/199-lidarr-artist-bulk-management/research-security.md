# Security Research — Lidarr Artist Bulk Profile and Tag Management

## Executive Summary

Issue #199 is safe to implement if it extends the existing sealed plan/apply
boundary instead of adding a direct bulk-mutation command. The repository already
provides the most important controls: one origin-bound authenticated transport,
header-only API-key injection, redirect rejection, bounded response parsing,
strict plan schemas, private atomic artifacts, SHA-256 tamper detection, target
origin matching, whole-plan and immediate per-target stale checks, exclusive plan
claims, bounded scheduler policies, durable per-target history, and explicit
resume.

No critical vulnerability was found in the proposed design. The release-blocking
security work is to preserve those controls while adding operation-specific
validation. In particular, planning must never infer the whole library from
omitted selectors; tag replacement and clearing must be unmistakably explicit;
profile and tag references must resolve uniquely against fresh resources; every
new plan/deferred field must be covered by canonicalization and checksums; and a
timeout or cancellation after request dispatch must be treated as an uncertain
desired-state transition until a fresh read reconciles it.

The checksum is an integrity seal, not an authenticity signature. It detects
corruption and casual editing, but a process that can rewrite a plan can also
recompute its SHA-256. Local file ownership and mode `0600`, target-origin
binding, explicit approval, and optional expected ID/checksum pinning make that
appropriate for the current single-user CLI model. Cross-user plan approval
would require a keyed MAC or digital signature.

**Confidence**: High — based on the current transport, facade, plan engine,
apply workflow, scheduler, deferred queue, history implementation, the repository's
pinned Lidarr OpenAPI contract, and official Lidarr controller source inspected
on 2026-07-23.

## Findings by Severity

### CRITICAL

No critical findings were identified, provided issue #199 remains plan/apply-only
and does not bypass the existing facade, transport, approval, origin, staleness,
or durable-history boundaries.

**Confidence**: High — the proposed feature does not introduce a new credential,
network origin, executable input format, or unauthenticated mutation path.

### WARNING

#### W1 — Omitted or truncated selection can create an unintended mass mutation

A mutation command that treats no selector as "all," reuses `lidarr list` paging,
or silently truncates a cap overflow can target a materially different cohort
from the one the operator intended.

Mitigation:

- Require at least one explicit selector or a dedicated, mutually exclusive
  `--all`.
- Resolve the complete cohort before applying `maxBatch`; fail on zero matches,
  unknown IDs, duplicate IDs, and cap overflow.
- Retain the default cap of 25 and hard maximum of 1,000. Raising the default
  should be an explicit operator action visible in the plan.
- Freeze sorted artist IDs in the artifact; never rerun selectors during apply.

**Confidence**: High — this follows the existing bounded plan contract and
OWASP's guidance to validate discrete input and log attempts to exceed
limitations in the
[Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
(live primary guidance, accessed 2026-07-23).

#### W2 — Tag `replace` and empty replacement can erase unrelated policy tags

Lidarr's editor supports `add`, `remove`, and `replace`; replacement overwrites
the complete artist tag set. An empty replacement therefore clears all tags and
can remove tags used by automation outside this feature. The official
[`ApplyTags`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/ApplyTags.cs)
and
[`ArtistEditorController`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/Artist/ArtistEditorController.cs)
(pinned source dated 2025-10-20) define these semantics.

Mitigation:

- Expose exact replacement as `set`, and clearing as a separate explicit
  `clear` intent; never interpret an omitted or accidentally empty variadic
  option as clear.
- Show the full before/after tag set and specifically list tags that replacement
  removes.
- Classify `set` and `clear` against the full live set and block on any
  concurrent change. Delta `add`/`remove` may tolerate unrelated tag changes.
- Always send explicit `applyTags`; never rely on a generated/server default.

**Confidence**: High — confirmed by official Lidarr source and the pinned
OpenAPI schema.

#### W3 — A SHA-256 plan checksum does not authenticate the plan author

The current seal covers a strict canonical representation and detects accidental
or uncoordinated edits. It is not keyed, so an attacker with write access can
change authoritative IDs and recompute the checksum. `createdBy` is audit
context, not authorization.

Mitigation:

- Preserve owner-only directories, mode `0600`, no-follow reads, file-identity
  checks, atomic no-overwrite writes, exclusive claims, and canonical-origin
  matching.
- Ensure every new operation field, per-entry before/after field, resolved
  resource ID, mode, cap, risk value, and idempotency key is included in the
  canonical checksum representation.
- In automation, require the reviewed `--expect-plan-id` and
  `--expect-plan-checksum` values rather than trusting a path alone.
- If plans become transferable between users or hosts, introduce a signed plan
  version with a separately protected signing key; do not describe plain
  SHA-256 as a signature.

**Confidence**: High — this is a direct property of the current unkeyed
`createHash("sha256")` implementation and threat model.

#### W4 — Numeric names and duplicate case-folded names can redirect intent

Accepting one string as either an ID or name makes a profile or tag literally
named `"12"` ambiguous. Case-insensitive name matching can also yield multiple
resources. Selecting the first match would make mutation authority depend on
server ordering.

Mitigation:

- Prefer separate `--*-id` and `--*-name` flags. If one reference syntax is
  retained, define positive decimal strings as IDs and require an explicit
  name prefix for numeric names.
- Trim input, use exact rather than fuzzy comparison, and require exactly one
  case-folded name match.
- Resolve from fresh bounded lists during planning and preflight; store the
  numeric ID as authority and the display name only for review.
- Reject deleted IDs before any write. A rename of the same ID should update
  review context, not redirect authority.

**Confidence**: High — Lidarr resources expose numeric IDs and nullable names,
and the official
[`ArtistEditorValidator`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/Artist/ArtistEditorValidator.cs)
(2025-10-20 pinned source) validates profile IDs, not user-facing names.

#### W5 — Timeout or cancellation can occur after Lidarr commits the mutation

Abort only proves the client stopped waiting; it does not prove the server did
not commit. Recording such an outcome as a definite failure can cause unsafe
replay or misleading automation.

Mitigation:

- Keep every request a one-artist, idempotent desired-state operation.
- After a successful `2xx`, re-read the artist and persist `succeeded` only if
  the managed fields match the planned after-state.
- On timeout, disconnect, or cancellation after dispatch, stop admitting new
  work when outcome cannot be reconciled immediately; record `deferred` or
  `uncertain`, never definite failure.
- Resume must re-read first: desired state becomes `satisfied`, reviewed before
  state may retry, and any third state blocks stale.
- Never automatically replay deferred work from startup, health, or unrelated
  commands.

**Confidence**: High — Node's `AbortSignal` reports cancellation of local work,
not transactional rollback
([Node.js AbortSignal documentation](https://nodejs.org/api/globals.html#class-abortsignal),
current documentation accessed 2026-07-23), while the existing apply engine
already models `deferred`, `uncertain`, `satisfied`, and explicit resume.

#### W6 — Per-target full-library reads amplify load at large batch sizes

The current immediate stale check calls `listArtists()` before each target.
Extending that behavior to 1,000 entries can download and parse the complete
library roughly 1,001 times, in addition to mutation and verification calls.
The 8 MiB response bound prevents unbounded memory use per response but not
aggregate request amplification.

Mitigation:

- Retain one full-list preflight, but add a narrow facade method backed by
  `GET /api/v1/artist/{id}` for immediate per-target checks and verification.
- Execute sequentially or within a deliberately small operation-specific
  concurrency limit; do not let the `local-only` lane's general concurrency of
  eight imply eight simultaneous bulk mutations.
- Keep the default batch at 25, enforce the hard 1,000-entry cap, honor timeouts
  and cancellation, and stop admission on late drift or uncertainty.
- Add response-count and string-length bounds to profile/tag projectors even
  though transport bytes are already bounded.

**Confidence**: High — directly observed in the current apply implementation;
OWASP identifies uncontrolled resource consumption and excessive batch work as
availability risks
([OWASP API Security Top 10, API4](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/),
2023).

#### W7 — The current production lockfile contains known availability vulnerabilities

`npm audit --omit=dev --json` on 2026-07-23 reported five vulnerable production
packages: direct `js-yaml`, `music-metadata`, and `picomatch`, plus transitive
`file-type` and `ws`. The issue #199 API path does not parse media files or use
WebSockets, but `js-yaml` is used for local configuration and is directly
reachable before command execution.

Mitigation:

- Upgrade `js-yaml` to at least `4.3.0`, `music-metadata` to at least `11.12.3`,
  `picomatch` to at least `4.0.4`, `file-type` beyond the affected range, and
  `ws` to at least `8.21.0`, subject to repository compatibility tests.
- Do not add a new runtime SDK for issue #199; use the checked-in generated
  client and built-in Fetch.
- Re-run production audit after lockfile updates and record any accepted,
  unreachable residual advisories.

**Confidence**: High — current lockfile versions and GitHub-reviewed advisories:
[`js-yaml` GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m)
(published 2026-07-02, updated 2026-07-20),
[`music-metadata` GHSA-v6c2-xwv6-8xf7](https://github.com/advisories/GHSA-v6c2-xwv6-8xf7)
(published 2026-03-17, updated 2026-03-19),
[`picomatch` GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj),
and [`ws` GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p),
verified 2026-07-23.

### ADVISORY

#### A1 — Command-line API-key overrides can leak through process inspection

The transport correctly injects `X-Api-Key` only after validating the final
same-origin request and excludes credentials from plans, queues, histories, and
errors. However, `--lidarr-api-key` can still be retained in shell history or
visible in process arguments.

Mitigation:

- Prefer configuration templates populated by the environment, dotenvx, or
  1Password; document the command-line option as a compatibility override.
- Never log the option value, request headers, raw generated request objects, or
  response bodies. Preserve recursive config redaction.

**Confidence**: High — direct local code inspection and OWASP's requirement that
API keys and access tokens never be logged
([Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
and [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html),
live primary guidance accessed 2026-07-23).

#### A2 — Non-TLS remote origins expose a bearer-equivalent API key

HTTP is useful for loopback or a trusted private Docker network, but sending the
Lidarr API key over untrusted HTTP exposes full API authority.

Mitigation:

- Recommend HTTPS for non-loopback/non-container-local origins and rely on
  Node's normal certificate validation.
- Preserve canonical origin matching and `redirect: "error"`; do not allow
  credentials in URLs or follow redirects.
- Do not broaden the transport to user-supplied arbitrary request URLs. OWASP
  specifically recommends allowlisting known destinations and disabling
  redirects for SSRF-sensitive clients
  ([SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html),
  live primary guidance accessed 2026-07-23).

**Confidence**: High — direct transport inspection and standard bearer-secret
threat model.

#### A3 — Plans and machine output contain operationally sensitive metadata

Plans intentionally contain artist names, tags, profile names/IDs, host, user,
working directory, and internal Lidarr origin. These are not authentication
secrets, but redirected JSON/CSV output and copied artifacts may disclose
library or network details.

Mitigation:

- Retain private artifact/history directories and `0600` files.
- Keep stdout machine-readable and credentials-free; send diagnostics to stderr.
- Document that plan and output files should be handled as private operational
  data and given an appropriate retention policy.

**Confidence**: High — direct inspection of current plan and output schemas.

## Authentication and Authorization

- Lidarr authenticates API requests with an API key and the current client uses
  only `X-Api-Key`. Preserve one authenticated Fetch owner in
  `transport.ts`; action and command layers must not receive headers or generated
  request objects. **Confidence**: High — official
  [`ApiKeyAuthenticationHandler`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Http/Authentication/ApiKeyAuthenticationHandler.cs)
  and local transport.
- Treat possession of the configured key as full Lidarr mutation authority.
  Issue #199 cannot enforce per-artist or per-field RBAC because Lidarr exposes
  no narrower token scope in this contract. The CLI's authorization boundary is
  therefore OS access to configuration/key material plus explicit plan approval.
  **Confidence**: High — official authentication source and editor endpoint
  contract.
- Real apply must require interactive confirmation or `--yes`; machine formats
  must never imply approval. `--all`, `set`, and `clear` should be repeated in
  the confirmation summary. **Confidence**: High — consistent with the current
  command contract.
- `createdBy` must remain informational. Do not reject legitimate resume solely
  because host/user text changed, and do not accept it as proof of identity.
  **Confidence**: High — it is checksum-covered metadata, not an authenticated
  principal.

## Data Protection

- Never serialize the API key, authorization headers, credential-bearing URLs,
  raw generated envelopes, or arbitrary response bodies into plan, history,
  deferred payload, logs, errors, JSON, YAML, or CSV. **Confidence**: High —
  preserves the current secret-free persistence boundary.
- Canonical plan data may store stable resource IDs and display names. Authority
  must derive from IDs; names are review context. **Confidence**: High.
- Validate new profile/tag labels and artist names as bounded strings without
  C0/C1 or bidi control characters before terminal or CSV rendering. Apply CSV
  formula-injection protection to cells beginning with `=`, `+`, `-`, or `@`.
  **Confidence**: Medium — terminal validation exists today; CSV behavior must
  be verified when new fields are projected.
- Error objects should contain stable error codes and safe operation labels.
  The current bounded error-body drain without body disclosure is the correct
  behavior. **Confidence**: High.
- Preserve private file modes, safe-parent ownership checks, no-follow I/O,
  atomic creation, byte limits, strict UTF-8/JSON parsing, and exact schema keys
  for every persistent artifact. **Confidence**: High.

## Dependency Security

| Dependency                                        | Role in issue #199                      | Current risk                                                                             | Required action                                                                                |
| ------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Built-in Node Fetch                               | Runtime HTTP transport                  | No added package; redirects and abort semantics remain security-sensitive                | Keep `redirect: "error"`, origin validation, timeout composition, and bounded bodies           |
| `@hey-api/openapi-ts` `0.93.0`                    | Dev-only generation from pinned OpenAPI | Generated-code supply-chain drift; no production runtime import                          | Keep exact pin, committed snapshot/provenance, offline drift check, and private generated tree |
| `better-sqlite3` `12.6.2`                         | Deferred-intent/circuit persistence     | Native dependency; no audit finding on 2026-07-23                                        | Retain parameterized SQL, schema constraints, bounded selectors, and lockfile integrity        |
| `p-limit` `6.2.0`                                 | Scheduler concurrency                   | No audit finding on 2026-07-23                                                           | Reuse scheduler; add a deliberately small mutation limit rather than new concurrency code      |
| `js-yaml` `4.1.1`                                 | CLI configuration                       | High quadratic-CPU advisory; patched in `4.3.0`                                          | Upgrade before or alongside release and test all config paths                                  |
| `music-metadata` `11.10.6` / `file-type` `21.3.0` | Unrelated media parsing                 | High/moderate infinite-loop and decompression-bomb advisories; not on Lidarr editor path | Upgrade and verify media parsing tests; do not treat path separation as a permanent exception  |
| `picomatch` `4.0.3`                               | Existing matching utilities             | High ReDoS/method-injection advisories; issue selectors should not add glob semantics    | Upgrade to a patched release; use exact selectors, not user-provided regex/glob patterns       |
| `ws` `8.19.0`                                     | Unrelated transitive runtime            | High memory-exhaustion advisory; no issue #199 WebSocket use                             | Upgrade transitive owner to obtain `ws >= 8.21.0`                                              |

**Confidence**: High — package-lock inspection and a fresh production
`npm audit` on 2026-07-23. Advisory reachability is High for `js-yaml` config
parsing and Medium/Low for packages outside the Lidarr command path.

## Input Validation

- Define exact discriminated unions for profile assignment and tag
  `add | remove | set | clear`; reject unknown keys at CLI-to-action,
  artifact, history, and deferred boundaries.
- Require unique positive safe integer artist/profile/tag IDs. Normalize tag
  arrays to sorted unique values and cap all arrays at 1,000.
- Require at least one managed profile field. Do not represent unsupported
  profile clearing with `0`, `null`, or omitted fields.
- Require at least one tag for `add` and `remove`; require non-empty tags for
  `set`; require no tag values for `clear`.
- Validate selectors independently from output paging. All filters use explicit
  AND semantics, and exact IDs plus filters must either be rejected as mixed
  modes or report every excluded ID.
- Project unknown wire data to narrow runtime-validated resources. Bound list
  counts, ID ranges, name/label lengths, and aggregate response sizes.
- Build editor bodies from an allowlisted constructor. For profile operations
  permit only `artistIds`, `qualityProfileId`, and/or `metadataProfileId`; for
  tags permit only `artistIds`, `tags`, and `applyTags`. Never spread a plan
  object into the generated request because the upstream editor resource also
  contains move/delete/exclusion fields.
- Derive idempotency keys from canonical origin, operation kind, tag mode,
  managed-field presence, resolved desired IDs, and artist ID. Deferred replay
  must exact-match both the operation name and payload.

**Confidence**: High — these controls extend current exact-schema and
operation-definition patterns and prevent mass-assignment into the broader
official `ArtistEditorResource`.

## Infrastructure Security

- Keep profile/tag operations in the `local-only` lane: they call Lidarr's local
  database API and do not need the external metadata health gate. Do not
  misclassify them as "destructive" merely to gain concurrency one; instead add
  operation-specific admission limits while reporting profile policy changes as
  medium product risk. **Confidence**: High.
- Preserve canonical HTTP(S) origin equality before credential injection and
  again between plan and configured client. Reject paths, queries, fragments,
  embedded credentials, sensitive query keys/values, preexisting sensitive
  headers, and redirects. **Confidence**: High.
- Keep success bodies capped at 8 MiB and error drains at 4 KiB. Add domain
  count bounds so a syntactically small but pathological resource list cannot
  create excessive per-entry work. **Confidence**: High.
- Maintain one exclusive per-plan claim and assert ownership before each remote
  write and durable record. Losing the claim must stop admission. **Confidence**:
  High.
- Do not combine multiple artists into one HTTP request until Lidarr's partial
  failure behavior is proven and the history model can represent every member
  without falsely assigning a shared result. **Confidence**: High for the
  current safety benefit; Medium on future batching feasibility.

## Secure Coding Guidelines

1. Extend `LidarrClientApi`; never import generated SDK functions above the
   private client layer or hand-write `/api/v1/` paths.
2. Add strict unknown-to-domain projectors for quality profiles, metadata
   profiles, and tags. Generated TypeScript types are not runtime validation.
3. Keep operation behavior centralized in the operation definition:
   canonicalization, risk, change detection, stale classification, request
   payload, idempotency key, deferred validation, and replay matching.
4. Use exhaustive switches over operation kinds and tag modes; a new enum member
   must fail compilation or validation until every safety behavior is defined.
5. Build minimal editor payloads explicitly and test that `rootFolderPath`,
   `moveFiles`, `deleteFiles`, `addImportListExclusion`, and monitoring fields
   are absent.
6. Perform a fresh whole-plan resource/artist preflight before any write, a
   targeted artist read immediately before each write, and a targeted
   verification read after each accepted write.
7. Stop later admissions on late drift, lost claim, cancellation, or uncertain
   outcome. Persist each authoritative target outcome synchronously before
   admitting the next target.
8. Test secret-shaped unknown keys recursively, checksum coverage of every new
   field, malicious control characters, numeric-name ambiguity, duplicate
   case-folded names, empty clear/set edge cases, cap boundaries, origin
   mismatch, redirects, timeout-after-commit, cancellation, and resume.
9. Keep logs structured and credential-free. Log plan ID/checksum, canonical
   origin, operation, counts, target ID, safe outcome/error code, and claim or
   resume events; never log full config, key, headers, or raw bodies.
10. Preserve architecture checks proving one production authenticated Fetch
    owner and no upper-layer generated imports.

**Confidence**: High — these rules are direct extensions of established
repository controls and official OWASP logging, validation, secrets, and SSRF
guidance cited above.

## Trade-off Recommendations

| Decision                 | Safer recommendation                                                             | Feature-value impact                                                                |
| ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Selection                | Explicit selectors or exclusive `--all`; default cap 25                          | One extra explicit flag for whole-library work; prevents catastrophic omission      |
| Profile/tag reference    | Separate ID/name flags, or fail every ambiguity                                  | Slightly larger command surface; deterministic authority                            |
| Tag clear                | Dedicated `clear`, never empty `set` by accident                                 | Clear remains available but unmistakable                                            |
| Tag delta vs exact state | Tolerate unrelated drift for add/remove; block all full-set drift for set/clear  | Preserves useful concurrent delta edits without risking overwrite                   |
| HTTP batching            | One artist per editor request                                                    | More requests, but exact stale checks, recovery, and auditability                   |
| Verification             | Targeted read after accepted mutation                                            | Extra request per changed artist; materially stronger outcome evidence              |
| Plan integrity           | SHA-256 plus private local storage now; signatures only for cross-user workflows | Avoids key-management burden while stating the local trust boundary honestly        |
| Transport                | Permit HTTP for trusted local origins; recommend HTTPS elsewhere                 | Preserves self-hosted Docker usability without normalizing cleartext remote secrets |
| Dependency remediation   | Upgrade vulnerable existing dependencies without adding a new SDK                | Some compatibility testing; reduces unrelated release risk                          |

**Confidence**: High — the recommendations preserve every requested profile/tag
capability while containing authority and recovery risk.

## Open Questions

1. Will plans ever be reviewed on one host/user and applied on another? If yes,
   who owns signing keys and trust policy for authenticated plans?
2. Should automation be required, rather than merely allowed, to provide the
   expected plan ID and checksum?
3. Are separate `--*-id` and `--*-name` flags acceptable, or is an explicit
   `id:`/`name:` reference prefix preferred?
4. Should `set` and `clear` receive a higher risk label or a second confirmation
   when they remove tags used by non-artist Lidarr configuration?
5. Can the facade add `getArtist(id)` for targeted stale checks, or must the
   implementation retain full-list reads and lower the hard batch cap?
6. After a mutation timeout, should immediate reconciliation be attempted once
   before recording `deferred`, and should an unreconciled result stop the
   whole run?
7. Must the existing production dependency advisories be fixed in issue #199,
   or will they be tracked in a separate release-blocking security issue?
8. Should non-loopback HTTP origins produce a warning or be rejected unless an
   explicit insecure-transport override is supplied?
9. Does the output layer already neutralize CSV formula cells for artist,
   profile, and tag names, or must issue #199 add that protection?
10. Should profile assignment remain medium risk and tag `add`/`remove` low
    risk, while `set`/`clear` are elevated to medium?
