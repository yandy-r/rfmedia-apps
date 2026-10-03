# Security Research: Lidarr Search and Lookup

## Executive Summary

Issue #222 is a read-only feature with no direct external-provider access and no need for a new
runtime dependency. Its security posture is acceptable if all calls remain behind the existing
origin-bound Lidarr transport and the implementation treats queries, response records, cached
projections, and rendered output as untrusted. The principal hard stop is any regression that lets
the API key enter URLs, redirects, logs, output, cache keys, or cache payloads.

Research date: 2026-07-23. Direct MusicBrainz, Last.fm, or other provider clients are out of scope.

## Findings by Severity

### CRITICAL — Hard Stops

| Finding                        | Risk                                                                                                                          | Required Mitigation                                                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Credential-boundary regression | A new fetch owner, generated auth, followed redirect, credential-bearing URL, or diagnostic could disclose the Lidarr API key | Invoke generated lookup functions only through `client.ts` and the sole transport; retain same-origin validation, `X-Api-Key` injection after validation, `redirect: "error"`, bounded error draining, and secret-free errors/cache/output. Add negative tests for every sink. |

No current credential disclosure was identified in the existing transport.

**Confidence**: High — verified directly in `transport.ts`; the feature design requires reuse of
that boundary.

### WARNING — Must Address

| Finding                                  | Risk                                                                                                                                    | Suggested Mitigation                                                                                                                                                                                                                                | Alternative                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Query and option validation              | C0/C1, escape, bidi, excessive Unicode, or unsafe integers can alter terminals, create ambiguous keys, or consume resources             | Trim once, NFC-normalize, require 1–256 code points and a bounded UTF-8 byte length, reject C0/C1/bidi controls, and validate `limit` 1–200 plus safe non-negative `offset` before client/cache I/O                                                 | A 512-code-point cap is acceptable only with the same byte/control bounds                                           |
| Cache-key collision or isolation failure | Another origin, lookup mode, normalization version, or projection version could satisfy the request                                     | Key by canonical credential-free origin × mode/category × projection version × SHA-256 of `mode + NUL + NFC(term)`; page options stay outside the key; validate cached payload on read                                                              | Persist cleartext normalized terms only with an explicit privacy decision; never include the API key                |
| Hostile or malformed response            | An 8 MiB JSON body can still contain huge arrays, deep optional data, unsafe strings, or ambiguous union members                        | Require an array, cap inspected entries at 1,000, bound every projected string/list, accept exactly one valid discriminator, copy only allowlisted scalar fields, reject the whole response atomically, and cache only the projection               | Lower the entry cap; native upstream pagination is unavailable                                                      |
| Terminal and CSV injection               | Remote titles can emit escape/bidi controls or spreadsheet formulas                                                                     | Reject controls in identifiers; sanitize display fields before terminal use; render no ANSI from data; use explicit flat CSV rows/columns and preserve recursive formula neutralization, including leading tab/CR/LF/`=+-@` and full-width variants | Document CSV as automation-only, but still neutralize because users may open it in a spreadsheet                    |
| Stale-result ambiguity                   | Automation may mistake cached data for live results or act on outdated identities                                                       | Require `--allow-stale`; emit `source`, `degraded`, `fetchedAt`, `ageSeconds`, and `fallbackReason` in machine output plus one stderr warning; enforce the stale ceiling                                                                            | Disable stale serving by configuring cache TTL to zero                                                              |
| Provider-outage misclassification        | A valid empty result or arbitrary `500` could be reported as an outage and trigger stale data                                           | Treat `200 []` as live success; construct metadata outage only from health/circuit evidence or a narrowly inspected bounded signal; never fall back for auth, validation, rate-limit, cancellation, or invalid response                             | Surface all ambiguous failures as `lidarr-unreachable` without stale fallback                                       |
| Retry amplification                      | Scheduler retry plus resilience retry and health probes could multiply calls during an outage                                           | Make the scheduler the only retry owner with `retryAttemptsOverride: 0`; do not retry metadata outages; honor cancellation and bounded `Retry-After`; test an exact maximum call count                                                              | Let resilience own retries only if the scheduler is configured for one attempt                                      |
| Existing dependency audit findings       | Current production audit reports five affected packages, although #222 adds none; `js-yaml@4.1.1` has a 2026 quadratic parsing advisory | Upgrade affected packages in a dedicated dependency change and rerun `npm audit --omit=dev`; do not parse provider data as YAML                                                                                                                     | Document temporary acceptance because lookup output uses `yaml@2.9.0` only for serialization, not `js-yaml` parsing |

**Confidence**: High for repository boundaries and the live 2026-07-23 audit; Medium for practical
spreadsheet behavior because applications differ.

### ADVISORY — Best Practices

| Finding                                | Benefit                                                                        | Recommendation                                                                                                                                                   | Defer Justification                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Query privacy at rest                  | Search terms can reveal listening interests                                    | Prefer a versioned SHA-256 cache discriminator and store projections without the query; do not log discriminator inputs                                          | Cleartext terms may be acceptable in a single-user local database after an explicit decision                                              |
| Mutable database path follows symlinks | Defense in depth against a locally replaced configured tracking DB             | Reuse parameterized cache CRUD and existing DB owner; separately harden mutable DB open with regular-file/symlink checks and restrictive parent/file permissions | This feature adds no path option or schema migration; an attacker able to replace same-user config is already in the local trust boundary |
| Cache growth                           | Unique searches can grow SQLite storage until opportunistic stale pruning runs | Prune on writes and consider a per-origin/category row or byte cap                                                                                               | Existing stale-age pruning is adequate for ordinary interactive use                                                                       |
| Supply-chain drift                     | Prevents accidental generated-client/runtime changes                           | Keep the pinned OpenAPI snapshot, exact generator version, generated-import gate, and lockfile review; add no feature dependency                                 | Existing codegen checks already provide most of this control                                                                              |

**Confidence**: Medium — these are defense-in-depth recommendations whose impact depends on the
local host trust model and query volume.

## Dependency Security

The dependency audit and supply-chain findings are classified in the tables above. Issue #222
requires no new runtime dependency; retain the pinned generator/lockfile controls and remediate the
current audit findings through a dedicated dependency update.

## Authentication and Data Protection

- The API key is configuration-only secret material. Commands/actions/public result types must not
  receive it except through the existing resolver; generated auth remains disabled.
- Errors must use typed codes and fixed messages. Never include a raw request, URL, response body,
  database path, query-bearing cache key, headers, or thrown dependency text in machine envelopes.
- Cache values contain only bounded artist/album projections and timestamps. SQL statements remain
  parameterized; no query text is interpolated into SQL.
- Canonical origin isolation is mandatory. If future Lidarr credentials have unequal permissions
  on one origin, add a non-secret connection-profile namespace; do not hash and persist the secret.

## Response, Output, and Availability Rules

- Preserve the transport's timeout, abort composition, 8 MiB success-body cap, 4 KiB error drain,
  fatal UTF-8 validation, and redirect rejection.
- Projection validation happens before dedupe, caching, ranking, paging, or rendering. Empty arrays
  are valid; partial salvage of malformed arrays is forbidden.
- JSON/YAML receive only fresh plain objects; CSV receives an explicit flat projection. Human output
  is stderr-only and machine output stdout-only so warnings cannot corrupt scripts.
- Cache fallback must preserve the original failure when the cache misses or database work fails.
  Corrupt, expired, wrong-origin, wrong-mode, or wrong-version entries are misses.

## Filesystem and Injection Non-Findings

- No command execution, shell interpolation, filesystem output, user-selected cache path, or dynamic
  SQL is required by #222; command injection, path traversal, and new SQL injection surfaces were
  not identified.
- No new HTTP listener exists, so browser CORS, CSRF, CSP, and session concerns do not apply.
- The feature performs no Lidarr mutation. Its only local write is the existing SQLite cache UPSERT.

**Confidence**: High — based on the issue scope and proposed file boundaries.

## Secure Test Requirements

1. Prove lookup calls use one same-origin request with `X-Api-Key`; reject alternate origin,
   username/password URLs, fragments, credential-like query/header input, redirects, and leaked-key
   error text.
2. Table-test empty/whitespace, NFC-equivalent, astral Unicode, over-code-point, over-byte, NUL,
   C0/C1, ESC, bidi controls, malformed exact-ID prefixes, unsafe `limit`, and unsafe `offset`.
3. Fuzz/project malformed JSON values, mixed/ambiguous unions, missing or duplicate IDs, oversized
   strings/lists, more than 1,000 entries, prototype-named properties, and terminal payloads;
   assert atomic `invalid-response` and no cache write.
4. Prove cache isolation across origin, mode, normalized term, and projection version; prove keys
   and payloads contain neither API key nor cleartext term; revalidate corrupt cached payloads.
5. Snapshot JSON/YAML/CSV/text for hostile names, formula prefixes (including full-width forms),
   quotes, delimiters, newlines, bidi, ANSI escapes, empty results, and degraded provenance.
6. Assert no stale fallback without consent, past the ceiling, or for auth/rate-limit/validation/
   cancellation/invalid-response; `200 []` never triggers fallback.
7. Assert scheduler-only retry, bounded total network calls, cancellation during preflight/backoff,
   and no retry for metadata-provider outage.
8. Run focused Vitest, typecheck/build, generated-import/fetch-owner/codegen gates, shell-completion
   parity, `npm audit --omit=dev`, and `git diff --check`.

## Trade-offs and Open Questions

- Prefer 256 code points plus a byte ceiling; business research says 512, but the security value of
  longer interactive search terms is low.
- Confirm whether cleartext query persistence is permitted; hashed discriminators are recommended.
- Confirm the stable empty CSV representation before freezing schema version 1.
- Dependency remediation is broader than #222 but should be tracked before the next release.

## Sources

- Repository: `transport.ts`, `metadata-cache.ts`, `resilience.ts`, `db.ts`, formatters, issue #222,
  and the external/business/technical research artifacts (read 2026-07-23).
- [OWASP CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection) (retrieved 2026-07-23).
- [MITRE CWE-117](https://cwe.mitre.org/data/definitions/117.html) (updated 2026, retrieved 2026-07-23).
- [Unicode UTR #36](https://www.unicode.org/reports/tr36/) (living report, retrieved 2026-07-23).
- [GitHub advisory GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m)
  (published 2026-07-02; patched in `js-yaml` 4.3.0).
