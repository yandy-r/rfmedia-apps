# Plex Adapter Refactor Security Research

## Executive Summary

The adapter refactor should be treated as a security-boundary refactor, not only
as code movement. The highest-priority defect is in the current adapter factory:
`plexUrl` and `plexToken` overrides are resolved independently. The MCP schemas
also accept both fields. An MCP caller can therefore supply an attacker-controlled
URL, omit the token, and cause the configured Plex token to be sent to that host.
This is a **CRITICAL** credential-exfiltration path and must be fixed before the
transport is reused behind a cleaner adapter API.

The refactor should centralize all Plex HTTP behavior in one transport with these
defaults: authenticated credentials are bound to one canonical origin, the token
is sent in `X-Plex-Token` rather than the query string, redirects are rejected,
request and operation budgets are enforced, response bodies are bounded, and
logs are structured and redacted. Private and loopback addresses cannot simply
be blocked because connecting to a LAN Plex server is a core CLI use case. The
correct SSRF control is instead to treat the locally configured endpoint as an
explicit allowlist entry and prevent remote/MCP callers from changing it.

Plex's current official API supports both legacy tokens and seven-day JWTs. The
adapter should introduce a token-provider seam now, but full PIN enrollment,
Ed25519 key custody, nonce handling, and JWT refresh should be a separate feature
unless issue #119 explicitly expands scope. A static-token provider preserves
compatibility without hard-coding legacy-token assumptions into the new
transport.

The package-lock baseline also needs attention. A local `npm audit --omit=dev`
on 2026-07-19 reported five production advisories (three high, two moderate),
including direct dependencies `music-metadata` and `picomatch`. These are not all
caused by issue #119, but a clean-install audit and disposition should be part of
the merge evidence. The refactor should avoid adding an unofficial Plex client
dependency; native `fetch` is sufficient. Add `jose` only if full JWT signing or
verification is implemented.

## Findings by Severity

### Critical Findings

| ID      | Finding                                        | Evidence and impact                                                                                                                                                                                                                                      | Required mitigation                                                                                                                                                                                                                                                                                                                                                               | Alternative                                                                                                                                                                                       |
| ------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-001 | Endpoint and credential overrides can be mixed | `lib/adapters/index.ts` resolves `plexUrl` and `plexToken` independently, while `mcp/schema.ts` accepts both and `mcp/adapters.ts` forwards them. An MCP caller can override only the URL and make the process send the configured token to that origin. | Resolve endpoint and credential as one provenance-bound connection. If a URL differs from the configured canonical origin, require an explicitly paired credential and reject fallback. Remove `plexUrl` and `plexToken` from MCP inputs; MCP should select a named, preconfigured connection. Add a regression test proving a URL-only override never uses the configured token. | For trusted CLI compatibility only, continue accepting both flags when they are supplied together, after an explicit warning and canonical-origin comparison. Never permit this path through MCP. |

### Warning Findings

| ID      | Finding                                                            | Evidence and impact                                                                                                                                                                                                                                                                                         | Required mitigation                                                                                                                                                                                                                                              | Alternative                                                                                                                                     |
| ------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-002 | Tokens are routinely placed in query strings                       | `lib/plex.ts` interpolates `X-Plex-Token` into most request URLs. URLs are more likely than headers to appear in proxy logs, diagnostics, exception traces, and monitoring.                                                                                                                                 | Send credentials only in the `X-Plex-Token` request header. Ensure errors, debug logs, mocks, and snapshots redact that header.                                                                                                                                  | Query authentication may remain only in an isolated compatibility fallback that is disabled by default and emits no URL-bearing logs.           |
| SEC-003 | Redirect behavior is implicit and unsafe for credentialed requests | Current `fetch` calls do not set `redirect`, so Node follows redirects by default. A compromised or misconfigured endpoint can redirect requests; query tokens are especially exposed.                                                                                                                      | Set `redirect: "error"` for authenticated requests. If redirect support is proven necessary, handle it manually, validate each destination against the bound origin, cap hops, and never forward credentials cross-origin.                                       | Allow a one-time, same-origin HTTP-to-HTTPS redirect only after explicit validation and tests.                                                  |
| SEC-004 | URL validation does not establish a safe request boundary          | `isValidPlexUrl` checks only `http:`/`https:`. `isSecurePlexUrl` is an incomplete private-address blocklist, does not resolve DNS, and would break legitimate LAN Plex endpoints if used globally. Existing URL construction also accepts credentials, query strings, fragments, and surprising base paths. | Parse and normalize once; reject embedded username/password, query, fragment, and unexpected base paths. Bind each credential to `URL.origin`. MCP requests may use only configured/named origins. Keep LAN and loopback support for locally configured CLI use. | An opt-in unrestricted CLI override can remain for a local operator, but must require a paired token and an explicit acknowledgement.           |
| SEC-005 | Cache entries are scoped to server URL, not authorization context  | `plex-cache.ts` keys entries as `${config.url}::...` and correctly omits the token, but different users/tokens for the same server can share cached libraries, playlists, or collections in a long-running MCP process.                                                                                     | Make cache state adapter-local or include a non-logged, stable credential-context fingerprint in keys. Clear it on credential rotation and adapter disposal. Bound TTL and entry count.                                                                          | Disable response caching in MCP mode until authorization-aware scoping is implemented.                                                          |
| SEC-006 | The transport lacks total operation and response-size budgets      | Each request uses a 30-second timeout, but pagination/batch operations can issue many requests without a total deadline or page/item cap. Several error paths call `response.text()` and include the result in errors or logs. A hostile endpoint can consume memory, time, or log volume.                  | Keep a per-request timeout and add an operation deadline, maximum pages/items, bounded concurrency, maximum success/error body sizes, and cancellation propagation. Truncate and sanitize error bodies before logging.                                           | Expose conservative advanced limits in configuration, with secure hard maximums that callers cannot exceed.                                     |
| SEC-007 | HTTP permits token disclosure on the local network                 | The validator intentionally accepts HTTP and many Plex installs use `http://host:32400`. Header authentication improves log safety but does not encrypt the token in transit.                                                                                                                               | Prefer HTTPS endpoints, warn on non-loopback HTTP, and document that HTTP exposes credentials to the local network. Never disable TLS certificate validation.                                                                                                    | Permit HTTP without warning only for loopback or a narrowly configured trusted environment.                                                     |
| SEC-008 | Authentication lifecycle is modeled as an immutable string         | Plex now recommends a JWT flow for new apps: Ed25519 registration/PIN enrollment, a five-minute nonce, seven-day JWTs, and refresh. A plain `config.token` cannot refresh or surface expiry safely.                                                                                                         | Introduce an async `TokenProvider`/credential provider returning an opaque token. Implement static-token compatibility now; map expiry/auth failures to typed errors. Keep private keys, nonces, JWTs, and refresh material out of cache and logs.               | Implement the complete JWT lifecycle in #119 only if secure key storage, atomic persistence, refresh tests, and UX are all accepted into scope. |
| SEC-009 | Authorization is represented by static adapter capabilities        | The adapter exposes capabilities such as playlist/collection mutation, but a shared Plex user or restricted token may not be authorized. Treating provider type as permission can create misleading or repeated privileged requests.                                                                        | Capabilities describe protocol support only. Preserve Plex 401/403 semantics in typed errors, do not retry with broader credentials, and let callers handle authorization denial explicitly.                                                                     | Add an optional, cached permission discovery step if Plex exposes a reliable endpoint for each operation.                                       |
| SEC-010 | Production dependency baseline contains known advisories           | `npm audit --omit=dev` reported five advisories: high findings affecting `music-metadata`, `picomatch`, and `ws`, plus moderate findings affecting `js-yaml` and `file-type`. The lockfile pins `music-metadata@11.10.6`, `picomatch@4.0.3`, `ws@8.19.0`, `js-yaml@4.1.1`, and `file-type@21.3.0`.          | Reproduce from a clean `npm ci`, upgrade to fixed compatible releases, run the full test suite, and document any accepted residual risk. Do not add a third-party Plex client for this refactor. Verify registry signatures/provenance where published.          | If upgrades are out of scope, open a linked remediation issue and require a time-bounded exception with reachability analysis.                  |
| SEC-011 | Raw credentials are accepted through observable interfaces         | MCP tool arguments include `plexToken`, and CLI commands expose `--plex-token`. MCP hosts, model traces, shell history, process listings, crash reports, or wrappers may retain these values.                                                                                                               | Remove token fields from MCP schemas. Prefer config templates populated from environment/1Password/dotenvx. Deprecate CLI token flags and warn that arguments are observable.                                                                                    | Accept a credential-reference name, never the secret value, through MCP/CLI.                                                                    |

### Advisory Findings

| ID      | Finding                                                           | Evidence and impact                                                                                                                                                                                                                 | Recommended mitigation                                                                                                                                                                                         | Alternative                                                                                                          |
| ------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| SEC-012 | Plex client identity is not centralized                           | Official Plex requests commonly use stable `X-Plex-Client-Identifier` and product/version metadata. Ad hoc calls make identity and JWT registration harder to reason about.                                                         | Have the transport add a stable installation-scoped client identifier and consistent public client headers. Do not use a secret as the identifier.                                                             | Use a deterministic, documented application identifier if per-install persistence is not yet available.              |
| SEC-013 | Debug logs expose operational metadata and accept untrusted text  | Debug output can include library names, media titles, filter text, machine identifiers, rating keys, source URIs, and local paths. Control characters can make terminal/file logs misleading.                                       | Use structured fields, escape control characters, classify path/title metadata as sensitive, and keep it behind explicit debug mode. Maintain a denylist for token, authorization, nonce, key, and JWT fields. | Hash identifiers and abbreviate paths in debug output.                                                               |
| SEC-014 | Secret-bearing config permissions are not enforced by the adapter | Config templates avoid committing resolved secrets, but a token still exists in process memory and may be stored in a local config generated with permissive filesystem permissions.                                                | When creating secret-bearing files, use owner-only permissions. Warn if an existing config is group/world-readable; do not print the token while diagnosing it.                                                | Store credential material in the OS credential store or external secret manager and keep only a reference in config. |
| SEC-015 | Path and identifier interpolation is inconsistent                 | Some values use `URLSearchParams`/`encodeURIComponent`, while many endpoints and rating keys are assembled with string interpolation. Future adapter methods may accidentally introduce path/query injection or malformed requests. | Centralize URL construction, encode query values, and validate endpoint-specific identifiers with conservative grammars and length bounds. Treat response-provided identifiers as untrusted.                   | Provide small typed route builders rather than a generic arbitrary-path request method.                              |
| SEC-016 | Response validation is partial and hand-written                   | Plex responses are checked unevenly and can contain large arrays, unexpected nesting, or malformed values. A hostile or incompatible server can propagate bad data into actions.                                                    | Validate only fields each method needs, enforce type/length/cardinality limits, and fail with redacted typed protocol errors.                                                                                  | Keep dependency-free guards for the current shapes; add a schema library only if already adopted elsewhere.          |
| SEC-017 | Fixed post-request delays do not provide a global rate limit      | The current 100 ms delay occurs per call and concurrent operations can still burst. This can trigger provider throttling or amplify denial-of-service effects.                                                                      | Put concurrency and rate limiting in the shared transport; honor `429` and bounded `Retry-After`, with jitter and a retry budget. Never retry 401/403 or non-idempotent mutations automatically.               | Set concurrency to one for mutation-heavy MCP operations until a shared limiter exists.                              |

## Authentication and Authorization

### Credential binding

SEC-001 is the release blocker. The current factory performs two independent
fallbacks:

```text
url   = override.plexUrl   ?? configured.url
token = override.plexToken ?? configured.token
```

This is unsafe whenever the caller can influence only one member of the pair.
Connection resolution should instead return an immutable object with provenance:

```text
PlexConnection {
  canonicalOrigin
  credentialProvider
  clientIdentity
  trustSource: configured | explicitCliPair
}
```

An endpoint change must invalidate the inherited credential. Compare canonical
origins, not raw strings: normalize scheme/host casing, default ports, and trailing
slashes before comparison. The MCP boundary should not accept arbitrary origins
or secrets at all. It should receive a connection name that resolves inside the
trusted local process.

### Token transport

Plex documents `X-Plex-Token` as the authentication header, although X-Plex
parameters may also be supplied as query parameters. Header transport is the
safer default because URLs are routinely captured by intermediaries. The
transport must never put tokens into error messages, cache keys, telemetry,
snapshots, request mock names, or retry metadata.

Use one redaction policy at the transport boundary. Redact case-insensitively:
`X-Plex-Token`, `Authorization`, `token`, `jwt`, `nonce`, `privateKey`, and any
credential-provider output. Sanitization should occur before formatting so an
exception cannot bypass it.

### Legacy tokens and JWT lifecycle

The official Plex API currently recommends JWT authentication for new apps. The
documented flow uses Ed25519 key material, PIN authorization for account linking,
a nonce valid for five minutes, a JWT valid for seven days, and refresh through
`POST https://clients.plex.tv/api/v2/auth/token`. Plex documents status `498` for
an expired JWT, `422` for a signature problem, and `429` for nonce rate limiting.

The adapter need not inspect or verify an opaque caller-provided JWT merely to
send it to Plex. It also must not decode an unverified JWT and trust its claims to
choose permissions or an endpoint. A token provider should own refresh behavior:

- `StaticTokenProvider` returns the existing configured token and preserves
  backward compatibility.
- A later `PlexJwtProvider` owns enrollment, durable client identity, refresh,
  clock-skew handling, and atomic credential replacement.
- Refresh should be single-flight so concurrent requests do not race or overwrite
  newer credentials.
- Private Ed25519 keys require owner-only storage or an OS/external credential
  store; neither private key nor JWT belongs in the response cache.
- Authentication retries must be bounded to one refresh-and-retry attempt and
  only when the request is safe to repeat.

The browser-inspected token flow described in Plex support documentation should
not become the application's enrollment mechanism. Plex notes that such tokens
may be temporary, and account security events can invalidate tokens.

### Authorization

Protocol capability and user authorization are different. `supportsCollections`
can say the adapter implements collection calls, but it cannot say the supplied
identity may create or delete a collection. Preserve 401, 403, and relevant Plex
error detail as typed, redacted failures. Do not fall back to another token,
silently broaden access, or repeatedly retry denied mutations.

## Data Protection

The existing cache has one strong rule worth preserving: token material is not
included in cache keys. The missing property is authorization isolation. Use an
adapter-local cache where possible. If a shared cache is required, scope it by
canonical server origin plus a non-logged authentication-context fingerprint,
category, and discriminator. A keyed or cryptographic fingerprint avoids storing
the raw token, but it is still sensitive metadata and should never be logged.

Cache only the minimum response fields required. Library, playlist, collection,
media-title, and local-path data can be private even when no credential is present.
Use a bounded TTL, maximum entry count, invalidation after mutations, and explicit
clearing when credentials rotate. MCP mode should default to no cross-request
cache until this isolation exists.

Do not serialize credentials into plan files. Existing plan tests that reject a
`plexToken` at any depth are a good invariant and should remain. Extend the same
negative assertion to JWTs, nonces, private keys, and credential references that
could resolve outside the local trust boundary.

For local configuration, retain template-based secret injection and avoid
resolved secrets in version control. Files created by the CLI that contain
credentials should be owner-readable/writable only. Debug mode should never
weaken redaction; it may expose operational metadata only after an explicit user
choice.

## Dependency Security

The adapter refactor does not need an unofficial Plex client library. Native
Node `fetch`, `URL`, `URLSearchParams`, `AbortController`, and the existing XML/
JSON parsing approach keep the dependency and maintenance surface smaller. If
full Plex JWT support is added, a maintained JOSE implementation such as `jose`
is preferable to handwritten Ed25519/JWK/JWT code, but it should be added only
after reviewing its current release, engines, transitive dependencies,
provenance, and maintenance history.

The 2026-07-19 audit result must be reproduced after `npm ci`; the inspected
worktree also contains copied/untracked `node_modules`, so the clean install is
the authoritative confirmation. The lockfile nevertheless pins the versions
listed in SEC-010, so the findings should not be dismissed as only an installation
artifact. For each advisory:

1. Upgrade to the smallest fixed compatible version.
2. Run package tests, type checking, build, and Plex action tests.
3. Record whether the vulnerable code is reachable from untrusted media, MCP
   inputs, WebSocket traffic, or config parsing.
4. Run `npm audit --omit=dev` again and retain the result in merge evidence.
5. Use `npm audit signatures` and published package provenance as supporting
   supply-chain checks; neither replaces review or vulnerability analysis.

Pinning through the lockfile, mandatory review of lockfile diffs, and avoiding
install scripts where practical are especially important for a CLI that handles
local filesystem access and long-lived Plex credentials.

## Input Validation

### URL policy

Rejecting all private IP ranges is not viable for this product. A safe policy is
contextual:

- **Configured local CLI connection:** allow HTTP/HTTPS Plex origins, including
  loopback and private networks. Warn on non-loopback HTTP.
- **MCP connection:** allow only a preconfigured/named canonical origin. No raw
  URL or token input.
- **Explicit CLI override:** require URL and token together, reject credentials/
  query/fragment in the URL, and make the trust decision visible to the operator.
- **Every redirect:** reject by default; otherwise reapply the same allowlist and
  credential-binding checks at each hop.

Do not use the existing `isSecurePlexUrl` blocklist as an SSRF guarantee. It does
not cover all IPv6, alternate IP encodings, DNS rebinding, or redirect cases.
OWASP recommends a positive allowlist where the application knows the expected
destinations and disabling redirect following in the HTTP client.

### Other inputs and responses

Construct URLs through the `URL` and `URLSearchParams` APIs. Validate numeric
rating keys and IDs where Plex defines them as numeric; encode path segments for
routes that accept opaque keys. Apply explicit maximum lengths to tokens, names,
filters, paths, IDs, and list counts. Reject ASCII control characters in tokens
and sanitize them in all loggable text without overconstraining opaque legacy or
JWT token formats.

Response data is untrusted even when it comes from a configured server. Enforce
content type where reliable, cap body bytes before parsing, limit array sizes and
pagination, and validate only required fields. An error response should contribute
at most a small sanitized excerpt (for example, 4 KiB) to diagnostics.

## Infrastructure Security

The transport should expose one request primitive responsible for:

- canonical-origin enforcement and credential binding;
- `X-Plex-Token` and stable public Plex client headers;
- `redirect: "error"`;
- connect/request timeout plus propagated caller cancellation;
- a total operation deadline and maximum request/page/item budget;
- global concurrency/rate limiting and bounded `429` handling;
- bounded response/error bodies and content validation;
- redacted structured logging and typed failures; and
- test injection of a mock fetch implementation without exposing credentials.

For long-running MCP processes, isolate adapters and caches per configured
connection. Apply least privilege to the process itself: it should not require
root, should read only needed configuration/media paths, and should not expose
the MCP server beyond its intended local transport without authentication. Never
recommend Plex's local-network authentication bypass as a workaround; Plex warns
that unauthenticated local access can expose the server and network.

TLS validation must remain enabled. Self-signed/private-CA environments should
install a trusted CA through the standard Node/runtime mechanism rather than set
global insecure TLS flags. If telemetry is ever added, it must exclude request
URLs, media names/paths, machine identifiers, and all authentication material by
default.

## Secure Coding Guidelines

1. Make secure behavior structural: methods receive a bound connection/transport,
   not independent URL and token strings.
2. Keep the token provider opaque. Callers may request a token for a request but
   cannot serialize, log, cache, or compare it.
3. Centralize requests; adapter methods must not call `fetch` directly or append
   `X-Plex-Token` to URLs.
4. Reject redirects by default and write tests for cross-origin, same-origin,
   relative, downgrade, and redirect-loop cases.
5. Use typed errors for timeout, cancellation, authentication, authorization,
   rate limit, protocol violation, and transport failure. Redact before creating
   the error message.
6. Give every loop a bound and every external body a size limit. Apply an overall
   deadline in addition to individual request timeouts.
7. Do not automatically retry non-idempotent playlist, collection, rating, or
   scan mutations unless an idempotency argument is proven.
8. Key caches by authorization context without storing/logging credentials; clear
   on mutation, expiry, rotation, and disposal.
9. Treat library names, media names, file paths, machine IDs, and rating keys as
   private operational data in logs and telemetry.
10. Add negative tests that assert secrets are absent from URLs, logs, errors,
    snapshots, plans, cache keys, and serialized adapter state.
11. Validate trust-boundary inputs at MCP/CLI/config entry, then preserve typed,
    normalized values internally rather than repeatedly parsing raw strings.
12. Review every new dependency and lockfile change; do not implement cryptography
    manually when a vetted, maintained library is genuinely required.

Minimum security regression tests for issue #119 should include:

- URL-only override plus configured token is rejected without making a request;
- MCP schemas contain neither raw URL override nor token fields;
- every authenticated request uses a header and no URL contains the token;
- a 3xx response cannot send credentials to another origin;
- separate tokens against one origin cannot share cached authorization data;
- timeout, cancellation, page cap, item cap, and body cap terminate cleanly;
- response and error logs redact reflected tokens and escape control characters;
- 401/403/429/498 responses map to the intended typed behavior; and
- HTTP warnings and HTTPS certificate validation behave as documented.

## Trade-off Recommendations

| Decision                          | Recommended choice                                                         | Why                                                                                  | Rejected or deferred alternative                                                                                |
| --------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| LAN SSRF policy                   | Trust an explicit locally configured origin; lock MCP to named connections | Preserves the primary local-server use case while removing remote endpoint selection | Blocking RFC1918/loopback addresses breaks normal Plex deployments and remains bypass-prone                     |
| Credential override compatibility | Remove from MCP; temporarily allow only paired CLI URL+token overrides     | Closes exfiltration while preserving a migration path for operators                  | Independent fallback is unsafe; unrestricted MCP overrides cross a remote trust boundary                        |
| Token placement                   | Header only                                                                | Reduces leakage through URL-centric logs and intermediaries                          | Query token support is legacy compatibility, not a safe default                                                 |
| Redirects                         | Reject                                                                     | Plex endpoints should be configured directly and credential protection is clearer    | Automatic following is unnecessary ambiguity; manual same-origin handling can be added if evidence requires it  |
| JWT scope                         | Add provider seam now; implement static provider in #119                   | Prevents architectural lock-in without expanding key-management scope                | Full enrollment/refresh is security-sensitive product work and should not be squeezed into transport extraction |
| Cache architecture                | Per-adapter, authorization-scoped, bounded                                 | Natural lifecycle and least cross-caller exposure                                    | URL-only global cache is simpler but unsafe in long-lived/multi-token processes                                 |
| HTTP support                      | Permit for local compatibility with a warning; prefer HTTPS                | Reflects real Plex deployments without pretending HTTP protects tokens               | An HTTPS-only breaking change needs separate migration planning                                                 |
| HTTP implementation               | Native `fetch` behind a small internal transport                           | No new Plex-client supply-chain surface and behavior remains explicit/testable       | Unofficial Plex SDKs are stale or incomplete relative to the repository's feature set                           |
| JWT crypto dependency             | Use a reviewed JOSE library only for actual JWT lifecycle work             | Avoids handwritten crypto while keeping current scope lean                           | Adding it solely to pass through opaque tokens creates cost without security benefit                            |
| Dependency advisories             | Clean-install audit and disposition before merge                           | Establishes an honest, reproducible baseline for credential-handling code            | Ignoring existing findings because they predate #119 leaves known exposure undocumented                         |

## Open Questions

1. Is the MCP server guaranteed to be local-only, or can another user, host, or
   model-controlled client invoke it? The recommendation removes secret/URL MCP
   arguments either way, but deployment controls depend on the answer.
2. Must issue #119 preserve `--plex-url` and `--plex-token` exactly, or can the CLI
   introduce a named connection and deprecation period?
3. Does Plex in supported deployments ever require an HTTP redirect? If so, what
   exact same-origin or upgrade-only cases must be allowed?
4. Is HTTPS available through `plex.direct`, a private CA, or a reverse proxy in
   the user's normal LAN deployment? This determines the most useful HTTP warning
   and migration guidance.
5. Does one process ever use multiple Plex identities against the same server?
   MCP longevity makes this possible even if normal CLI commands are short-lived.
6. Which Plex operations are safe to repeat after token refresh or transient
   failure? Mutation retry policy needs operation-specific answers.
7. Where should a future stable client identifier and Ed25519 private key live,
   and which OSes must secure storage support?
8. Should seven-day JWT enrollment/refresh be a child issue with its own threat
   model and recovery UX, or is it an acceptance criterion for #119?
9. What maximum page, item, response-byte, and operation-time budgets preserve
   expected large-library workflows?
10. Are debug logs routinely attached to bug reports? If yes, paths, media names,
    machine IDs, and rating keys need a stronger support-bundle redaction policy.
11. Can the five production audit advisories be upgraded within current semver
    ranges, and which are reachable from MCP-controlled or media-file inputs?

## Primary Sources Consulted

- [Plex Media Server API documentation](https://developer.plex.tv/pms/) — current
  authentication headers, client identity, JWT enrollment/refresh, lifetimes,
  and error behavior.
- [Plex: Finding an authentication token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)
  — legacy token discovery, temporary-token caveat, and third-party application
  guidance.
- [Plex: Authentication for local network access](https://support.plex.tv/articles/200890058-authentication-for-local-network-access/)
  — risks of unauthenticated local-network access.
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
  — allowlisting, DNS nuance, and redirect controls.
- [OWASP SSRF Prevention in Node.js](https://owasp.org/www-community/pages/controls/SSRF_Prevention_in_Nodejs.html)
  — Node-specific validation and network-layer defense considerations.
- [Node.js v22 globals documentation](https://nodejs.org/download/release/latest-v22.x/docs/api/globals.html)
  — `fetch`, `AbortController`, and `AbortSignal.timeout` behavior.
- [npm audit documentation](https://docs.npmjs.com/cli/audit/) — audit report and
  remediation semantics.
- [npm package provenance documentation](https://docs.npmjs.com/viewing-package-provenance/)
  — registry signatures and published provenance verification.

Repository evidence was inspected directly in `packages/rfmedia-cli/src`, notably
`lib/adapters/index.ts`, `lib/plex.ts`, `lib/plex-cache.ts`, `mcp/schema.ts`,
`mcp/adapters.ts`, Plex actions/commands, plan serialization tests, and
`package-lock.json`.
