# Security Research: Lidarr Similar-Artist Discovery

Research date: 2026-07-25.

This review covers GitHub issue
[#203](https://github.com/yandy-r/rfmedia-apps/issues/203), the current
`rfmedia-cli` security boundaries, and the official Last.fm API contract. Last.fm's live API
documentation and Terms of Service are undated; each Last.fm source below was accessed on
2026-07-25.

> **Freshness note:** Last.fm can change its terms, rate limits, and permitted data use without an
> API version change. Recheck the live method page, introduction, and Terms of Service immediately
> before release.

## Executive Summary

The read-only command is feasible with a small attack surface if it uses a dedicated Last.fm
transport, a fixed HTTPS origin, bounded response parsing, strict projection, terminal-safe
strings, and the existing `discovery` scheduler lane. It must work with no Lidarr configuration or
Lidarr network call. Last.fm's `artist.getSimilar` endpoint needs only an application API key; it
does not need a user session, API signature, or shared secret
([official method contract](https://www.last.fm/api/show/artist.getSimilar), undated).

The one CRITICAL finding is the optional add handoff. Last.fm data is untrusted recommendation
evidence, not a valid Lidarr mutation payload or authorization decision. The current facade exposes
lookup but no artist-add method, and the current sealed plan model has no artist-add operation.
Issue #203 should either add an exact-candidate, separately approved plan/apply operation or ship
read-only discovery now and defer add. An inline `--add` that silently selects a result, constructs
a POST from Last.fm data, or enables Lidarr search/download defaults is not acceptable.

The principal WARNING findings are API-key leakage through query URLs and command-line arguments;
HTTPS/origin/redirect enforcement; malformed or oversized provider responses; terminal control
injection; provider-aware rate limiting and cancellation; cache privacy and poisoning; and
attribution/provenance loss. There is no need for a new runtime dependency: Node.js 22 has stable
native `fetch` and `AbortSignal`, while Last.fm labels the SDKs on its tools page unofficial and
unsupported.

**Confidence**: High. The endpoint and terms findings come from current primary sources, and the
repository findings come from the issue-203 worktree as of 2026-07-25. Confidence is Medium only
where Last.fm leaves behavior unspecified, principally numeric rate limits, maximum result count,
and cache-header behavior.

## Findings by Severity

### CRITICAL

| ID  | Finding                                                                                          | Evidence and impact                                                                                                                                                                                                                                                                                                                                        | Required mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Confidence                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| C-1 | The add handoff can cross an authorization boundary and trigger downstream acquisition activity. | `artist.getSimilar` returns recommendations, not trusted Lidarr resources. The repository currently has generated `POST /api/v1/artist` code but no public `addArtist` facade and no sealed artist-add plan operation. A direct or implicit add could select the wrong identity, add more than intended, and activate monitoring/search/download behavior. | Keep discovery read-only by default. Require one explicit stable selection (`rank` plus sealed candidate identity, preferably MBID), resolve it through Lidarr artist lookup, and use only the authoritative Lidarr lookup resource as the basis of an add. Require explicit root folder, quality profile, metadata profile, monitor policy, and search policy. Seal provider, method, requested seed, resolved seed, candidate rank/name/MBID/score, target Lidarr origin, and desired add options into a checksum-protected plan; revalidate absence and identity at apply time. Require interactive confirmation or `--yes` for non-interactive use, cap the initial operation at one artist, and never offer `--add-all`. If this plan/apply work is outside issue #203, defer add rather than implementing an inline POST. | High — current repository contracts and Lidarr's generated OpenAPI surface confirm the missing safe mutation boundary. |

### WARNING

| ID  | Finding                                                                                                                           | Evidence and impact                                                                                                                                                                                                                                                                                                                                                                                                                                  | Required mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Confidence                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| W-1 | Last.fm requires the API key in the request query, creating URL and process-argument leakage risks.                               | The official REST and method pages require `api_key` as a query parameter. Full URLs can leak through debug logs, thrown errors, proxies, telemetry, caches, or test snapshots. A `--lastfm-api-key` value is also visible to shell history and potentially process inspection. The key is an application credential: abuse can consume quota or cause suspension even though it is not a Last.fm user session.                                      | Prefer `lastfm.apiKey: "{{ LASTFM_API_KEY }}"` and the existing dotenvx/1Password re-exec paths. Do not document a CLI key flag as the preferred flow; if provided for parity, warn that it is exposed in argv. Keep the key off enumerable connection objects, inject it only at the final transport call, and never log, stringify, cache, persist, or include the full request URL or `Request`. Redact `api_key`, `api-key`, and the exact configured value from every human and machine failure path. Test error causes, debug mode, JSON/YAML/CSV output, snapshots, and serialization for absence of the key.                                                                                       | High — the query requirement is explicit in Last.fm's official REST documentation.                                                  |
| W-2 | A configurable or redirect-following provider endpoint could leak the query credential and enable SSRF.                           | Last.fm's documentation still shows an HTTP API root, while the live service is reachable over HTTPS. Native fetch follows redirects by default. A redirect would resend a query containing `api_key`, and a configurable base URL would turn artist input plus a credential into an SSRF primitive.                                                                                                                                                 | Hard-code `https://ws.audioscrobbler.com/2.0/`; do not expose a production endpoint override. Require exactly the `https:` protocol, expected hostname, empty username/password/fragment, and fixed `/2.0/` path before adding the credential. Use `redirect: "error"` and fail closed on every redirect status. Do not fetch provider-returned artist or image URLs. Register exactly one new Last.fm transport as an authorized fetch owner in the architecture checker and add count/ownership tests.                                                                                                                                                                                                   | High for the redirect and origin risk; Medium for provider HTTPS policy because the official prose remains outdated and shows HTTP. |
| W-3 | Provider responses can cause memory exhaustion, parser abuse, or type confusion unless bounded and projected.                     | Last.fm documents XML-to-JSON conversion rules in which numeric-looking values remain strings and repeated elements become arrays. It does not publish a maximum `artist.getSimilar` limit. The existing Lidarr transport's 8 MiB generic limit is unnecessarily large for a small discovery response.                                                                                                                                               | Stream and cap success bodies before decoding (recommended 1 MiB) and error bodies (recommended 4 KiB); use fatal UTF-8 decoding; require JSON and reject JSONP. Set an application maximum such as `limit <= 100` with a default of 25. Require an exact envelope; cap candidate count; parse `match` as a finite number in `0..1`; validate MBIDs; bound every string by UTF-8 bytes; deduplicate candidates by MBID or normalized provider identity; and project into fresh immutable domain objects. Parse `{ error, message }` even on HTTP success and never surface raw bodies.                                                                                                                     | High for the need for bounds and runtime validation; Medium for the proposed numeric caps because Last.fm publishes no maximum.     |
| W-4 | Artist names, provider messages, and URLs can inject terminal control sequences or misleading bidirectional text.                 | Human output uses terminal tables and stderr; provider strings are untrusted. Truncation and table formatting do not make escape sequences safe. Current Lidarr projections already reject C0, DEL/C1, and Unicode bidi controls.                                                                                                                                                                                                                    | Apply the existing terminal-safe label contract before any log, table, prompt, plan, or error construction: reject C0/C1 controls, ESC, line breaks, and `Bidi_Control`; require non-empty bounded strings; and truncate only after validation. Do not include provider error messages verbatim. Validate machine output too so downstream terminals remain safe. Test ANSI color injection, OSC hyperlinks, CR/LF prompt spoofing, bidi overrides/isolates, zero-width edge cases, and overlong Unicode.                                                                                                                                                                                                  | High — the sink and proven repository mitigation are directly observable.                                                           |
| W-5 | The current discovery scheduler lane is not, by itself, a complete Last.fm retry/rate-limit implementation.                       | The lane provides concurrency, budget, abortable waits, and idempotency gates, but its retry classifier accepts only `LidarrError`. Last.fm signals rate limiting with API error `29`, which may arrive as a JSON error, and publishes no fixed numeric quota. The default discovery lane concurrency is four with two retries, while Last.fm warns against continuously making several calls per second.                                            | Use the discovery lane for admission and cancellation, but introduce a provider-neutral, explicitly classified transient-error contract or a single narrowly owned Last.fm retry layer. Do not mislabel Last.fm failures as Lidarr failures and do not let both layers retry. One seed should normally make one request. Retry only transport timeouts, temporary codes `11`/`16`, and rate-limit code `29`; honor a valid `Retry-After` within the configured cap, use capped jitter otherwise, and never retry invalid/suspended keys or malformed input. Keep provider concurrency at one unless measured and approved. Ensure cancellation interrupts queued admission, fetch, body read, and backoff. | High for the current scheduler behavior and Last.fm error codes; Medium for pacing because Last.fm publishes no numeric limit.      |
| W-6 | A persistent discovery cache can expose listening interests and can poison later output or add decisions.                         | Existing Lidarr cache rows are keyed by credential-free origin and revalidated before stale serving, but the shared tracking database creation does not explicitly enforce private directory/file modes. Discovery seeds and recommendations reveal user interests. A tampered or stale cache could alter ranking or candidate identity. Last.fm also requires caching in accordance with response headers and caps retained Last.fm data at 100 MB. | Prefer no persistent Last.fm cache in the first read-only release unless rate behavior requires it. If added, use a distinct provider category and key of provider, method, normalized seed or MBID, autocorrect mode, and limit — never the API key. Store provider provenance and fetch time, obey cache headers, enforce an aggregate size below 100 MB, add purge/expiry support, and enforce `0700` directory plus `0600` database/sidecar permissions. Strictly revalidate cached projections and never authorize add from cache without a live Lidarr lookup and a sealed selection. Corrupt or mismatched cache rows must be misses, not partial successes.                                        | High for privacy/poisoning controls; Medium for actual cache headers because behavior is not documented per method.                 |
| W-7 | Missing provider provenance or attribution creates misleading output and Terms-of-Service risk.                                   | Last.fm requires credit and links where its data is used, requires licence references on published copies, and restricts use to non-commercial purposes absent a separate agreement. Provider rankings may change, and `autocorrect=1` can change the seed identity.                                                                                                                                                                                 | Every human and machine result must include `provider: "last.fm"`, source method, requested seed, provider-resolved seed, autocorrect status, fetched-at time, rank, raw similarity score, MBID when valid, and a validated Last.fm catalogue URL. Label `match` as a Last.fm similarity score, not probability or confidence. Preserve this provenance in any add plan and audit record. Include clear Last.fm credit/link output and documentation; do not output or cache images/artwork. Require users to supply their own API key and disclose the non-commercial/commercial-agreement constraint.                                                                                                    | High — attribution, non-commercial use, and image exclusion are explicit in Last.fm's official Terms.                               |
| W-8 | Sharing Lidarr connection resolution or cache origin with discovery would violate isolation and can expose unrelated credentials. | `resolveRequiredLidarrExecutionContext` requires a Lidarr URL and API key and scopes state to the Lidarr origin. The `discovery` tier is explicitly ungated and independent of Lidarr. Using the Lidarr client context for convenience would make read-only discovery fail without Lidarr and risk mixing provider and Lidarr state.                                                                                                                 | Resolve Last.fm configuration independently. The default action may call the process-wide scheduler but must not call a required Lidarr resolver, Lidarr health preflight, generated Lidarr client, or Lidarr cache helper. Instantiate Lidarr only inside the separately authorized add branch. Keep provider circuit/cache identifiers separate from Lidarr origins and error taxonomies. Add a test that read-only discovery succeeds with no Lidarr config and asserts zero Lidarr calls.                                                                                                                                                                                                              | High — the current resolver and tier descriptor make this boundary explicit.                                                        |

### ADVISORY

| ID  | Finding                                                                                                | Evidence and impact                                                                                                                                                                                                                                                                               | Required mitigation                                                                                                                                                                                                                                                                                        | Confidence |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A-1 | `artist.getSimilar` does not need Last.fm user authentication.                                         | The official method page says the service does not require authentication while still requiring an application `api_key`. Last.fm user flows add `sk`, `api_sig`, and a shared secret only for authenticated services. Adding those credentials would enlarge impact without enabling issue #203. | Store only an application API key. Do not accept or persist a Last.fm username, password, session key, API signature, callback token, or shared secret. Reject such fields as unknown/unsafe if a strict `lastfm` config section is added.                                                                 | High.      |
| A-2 | A Last.fm SDK adds supply-chain and maintenance risk without reducing the validation burden.           | Node.js v22 documents native `fetch` and `AbortSignal` as stable. Last.fm labels its listed tools unofficial and unsupported. Its linked JavaScript wrapper is browser-oriented, exposes authentication/caching, has no releases or packages, and its latest commit is dated 2019-12-09.          | Use native Node.js `fetch`, `URL`, `URLSearchParams`, `AbortSignal`, and `TextDecoder`; add no Last.fm runtime package. Retain dependency lockfile review and the single-fetch-owner architecture test.                                                                                                    | High.      |
| A-3 | Existing secret templating and config redaction are reusable but need Last.fm-specific contract tests. | Config injection logs variable names only, `apiKey` matches the sensitive-field redactor, config size is capped at 1 MiB, and Lidarr failure reporting redacts query keys and exact CLI credential values. These controls are convention-based and easy to bypass in a new command module.        | Add `lastfm.apiKey` to typed validation, use a `{{ LASTFM_API_KEY }}` example, reject empty/control-bearing keys, and centralize provider error rendering. Test merge debug logs, missing templates, direct configured values, wrapper re-exec, thrown causes, JSON serialization, and all output formats. | High.      |
| A-4 | Provider-returned links should be treated as attribution data, not navigation or fetch instructions.   | Last.fm responses contain artist and image URLs, including historical HTTP examples. Automatically opening or fetching them expands origin trust, leaks operator IP/activity, and introduces image/content risk.                                                                                  | Accept only a normalized `https://www.last.fm/...` catalogue URL for output, or construct the catalogue link from a validated provider path. Never open it automatically. Drop all image and streamability fields from the domain model.                                                                   | High.      |
| A-5 | Seed text is user-controlled and privacy-relevant even when it is not secret.                          | The artist name appears in command arguments and may appear in shell history, process listings, output files, and caches. It can reveal preferences but is required for the command.                                                                                                              | Document this exposure, avoid duplicating the seed in debug/error output, do not include it in telemetry, and provide MBID input in future if users need a less ambiguous stable identifier. Do not incorrectly redact ordinary artist names as credentials.                                               | Medium.    |

## Authentication and Authorization

Last.fm distinguishes an application API key from authenticated user sessions.
`artist.getSimilar` requires `api_key` but explicitly says it does not require authentication
([method page](https://www.last.fm/api/show/artist.getSimilar), undated). The user-authentication
flow adds a shared secret, API signature, and session key for authenticated services
([web authentication guide](https://www.last.fm/api/webauth), undated). None of those user
credentials belongs in issue #203.

Recommended configuration:

```yaml
lastfm:
  apiKey: "{{ LASTFM_API_KEY }}"
```

The configuration validator should accept a non-empty bounded string without control characters.
It should not persist a resolved value. The existing template path is suitable because it resolves
from the environment, fails when the variable is missing, and logs only the variable name.
`apiKey` is already matched by the recursive sensitive-field redactor. The new provider command
must still pass its key as an explicit sensitive value to its failure renderer because config
redaction does not automatically sanitize arbitrary errors.

The API key should remain off enumerable objects, following the current Lidarr `WeakMap` credential
binding. It should be origin-bound and exposed only through a private asynchronous credential
provider at the final transport step. Do not embed it in action options returned to callers or in
structured execution metadata.

Authorization for add is independent of possessing either API key. A Last.fm key authorizes a read
from Last.fm; a Lidarr key authorizes API access to the configured Lidarr instance; neither proves
the operator intended to add a specific artist or allow monitoring/searching. The add gate must
therefore bind all of the following:

- The exact Last.fm candidate identity and rank the operator selected.
- The authoritative candidate returned by Lidarr lookup.
- The exact Lidarr origin.
- Root folder, quality profile, metadata profile, monitoring policy, and search policy.
- A one-artist maximum for the first release.
- An interactive confirmation, or explicit `--yes` in non-interactive mode.

The current plan/apply system already provides target-origin checks, checksums, expected plan
ID/checksum, live-state preflight, claims, history, cancellation, and non-interactive approval
gates. Artist-add should use an equivalent operation definition instead of creating a bypass.
Because no artist-add definition exists today, read-only-only delivery is safer than treating
`--add` as a small command-layer option.

## Data Protection

The official REST protocol requires `api_key` and `method` in the query
([REST requests](https://www.last.fm/api/rest), undated). HTTPS protects the query in transit, but
not from application logs, shell arguments, local proxies, or accidental object serialization.
The implementation should retain a constant credential-free log context such as:

```text
provider=last.fm operation=artist.getSimilar timeoutMs=...
```

It must never retain or render `request.url`, `URL.href`, a `Request`, or an error cause whose
message includes the URL. Provider errors should be translated into fixed local messages and typed
metadata; raw Last.fm bodies and messages are not safe output.

Discovery data is not generally an account identifier because issue #203 sends only an artist
seed, but it still reveals interests. Machine output and user-created files are intentionally under
the operator's control. Automatic persistent storage is different: it needs an explicit retention
policy, private filesystem permissions, bounded total size, purge support, and revalidation.

Last.fm's Terms require suitable caching in accordance with response headers, cap retained data at
100 MB, require privacy/confidentiality standards, and require deletion after termination
([Terms of Service](https://www.last.fm/api/tos), undated). The simplest compliant first release is
one bounded live request with no persistent provider cache. If caching is introduced, capture and
obey response caching metadata, keep a provider-specific size budget comfortably below 100 MB, and
do not retain images.

Output should carry only the fields required for discovery and attribution:

- Candidate name, validated MBID when present, rank, and similarity score.
- Requested and provider-resolved seed.
- Provider identifier, source method, and fetch timestamp.
- A validated HTTPS Last.fm catalogue link.

Drop image URLs, streamability flags, unexpected keys, raw response fragments, and the API key.
Last.fm's Terms expressly exclude audio, audiovisual content, images, and artwork from the granted
licence
([Terms, clause 5.1.8](https://www.last.fm/api/tos), undated).

## Dependency Security

No new runtime dependency is justified. The package requires Node.js 22+, whose official
documentation marks global `fetch` and `AbortSignal` stable
([Node.js 22.17 globals](https://nodejs.org/download/release/v22.17.0/docs/api/globals.html),
versioned documentation accessed 2026-07-25). Native platform APIs cover the entire requirement:

- `URL` and `URLSearchParams` for RFC 3986-compatible query encoding.
- `fetch` with `redirect: "error"` and an abort signal.
- A streamed body reader with byte limits.
- Fatal `TextDecoder` UTF-8 validation.
- `JSON.parse` followed by local runtime guards and projection.

Last.fm's tools page states that its listed API tools are unofficial and unsupported
([API Tools](https://www.last.fm/api/downloads), undated). The linked
[`fxb/javascript-last.fm-api`](https://github.com/fxb/javascript-last.fm-api) wrapper is aimed at
browsers and optional `localStorage`, includes user authentication and write support, publishes no
release or package, and last changed on
[2019-12-09](https://github.com/fxb/javascript-last.fm-api/commit/803cc958f248312beffe12f548163a07d53b4d5b).
It would add code, MD5/authentication paths, and transitive review obligations without removing the
need for local secrecy, bounds, error mapping, or response validation.

The repository architecture checker currently permits production fetch only in the Plex and
Lidarr transport owners. A Last.fm transport must be added as one conditional, exactly-one fetch
owner, with tests that reject:

- Fetch from the discovery action or command layer.
- A second fetch in another Last.fm module.
- Imports of private provider wire types outside the adapter/facade.
- Direct imports of generated Lidarr code from the discovery action.
- Calls to any future `addArtist` method outside its registered plan operation owner.

## Input Validation

Validate all operator input before loading the action, provider, cache, or Lidarr modules.
Recommended initial contract:

| Input                      | Validation                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--artist`                 | Trim for lookup while preserving the original display spelling; require 1-2,048 UTF-8 bytes; reject C0/C1 controls and Unicode bidi controls. |
| `--limit`                  | Decimal safe integer, default 25, application maximum 100.                                                                                    |
| `--min-match` if added     | Finite decimal in `0..1`; do not accept `NaN`, infinity, percentages, or locale-specific forms.                                               |
| API key                    | Non-empty bounded string; reject controls; never trim or normalize the credential silently.                                                   |
| Candidate selector for add | One exact positive rank plus a sealed stable identity; reject ranges, comma lists, duplicates, and `all`.                                     |
| MBID                       | Canonical UUID syntax; normalize case only after validation.                                                                                  |

Last.fm says API arguments must be UTF-8 and requests should use RFC 3986-compliant encoding
([API introduction](https://www.last.fm/api/intro), undated). Construct query parameters only with
`URLSearchParams`; never interpolate the artist name into a URL string.

The response must be treated as `unknown`. With `format=json` and no `callback`, Last.fm promises
pure JSON and documents that XML attributes/text are represented as strings while repeated
children become arrays
([REST JSON rules](https://www.last.fm/api/rest), undated). The projector should:

1. Detect `{ error, message }` before interpreting a success envelope, regardless of HTTP status.
2. Require a `similarartists` object and a provider-resolved seed string.
3. Require `artist` to be an array, allowing an absent/empty result only if the live fixture proves
   that shape; do not coerce arbitrary objects.
4. Reject more than the application cap and reject oversized nested structures.
5. Require a terminal-safe name.
6. Parse `match` from a string or number only when the complete value is finite and within `0..1`.
7. Treat empty MBIDs as absent and accept non-empty MBIDs only when they match canonical UUID
   syntax.
8. Validate catalogue URLs against an allowlist and output only normalized HTTPS links; never
   fetch them.
9. Deduplicate with deterministic first-win ranking and return new frozen objects.
10. Ignore unneeded fields by projection, not by forwarding the wire object.

The official method describes `match` as a similarity value between zero and one and documents
codes `10` (invalid key), `11` (offline), `16` (temporary error), `26` (suspended key), and `29`
(rate limit)
([`artist.getSimilar`](https://www.last.fm/api/show/artist.getSimilar), undated). Map those into a
provider-specific error taxonomy with fixed sanitized messages. Unknown errors should fail closed
and should not be retried by default.

## Infrastructure Security

The transport should mirror the strongest existing Lidarr transport properties while accounting
for the unavoidable query credential:

- Fixed `https://ws.audioscrobbler.com/2.0/` endpoint and exact-origin validation.
- No userinfo, fragment, alternate hostname, alternate path, or endpoint configuration.
- `GET`, `Accept: application/json`, and an identifiable, versioned `User-Agent`.
- `redirect: "error"` so the credential is never forwarded.
- One composed abort signal covering caller cancellation and a hard timeout.
- Bounded body streaming, including cancellation of the reader on overflow or abort.
- Error mapping that never retains raw URLs, bodies, or provider messages.
- Exactly one fetch owner behind a private facade.

Last.fm explicitly requests an identifiable `User-Agent`, RFC 3986 URL encoding, and reasonable
traffic; it warns that continuously making several calls per second or excessive calls can suspend
an account
([API introduction](https://www.last.fm/api/intro), undated). The Terms say rate limits are
discretionary and must not be circumvented
([Terms](https://www.last.fm/api/tos), undated). Therefore:

- A normal command should issue exactly one `artist.getSimilar` request.
- Do not precede it with `artist.search` unless the user explicitly enters a disambiguation flow.
- Run in the existing `discovery` lane with a provider-specific concurrency ceiling of one.
- Keep retries bounded and owned by exactly one layer.
- Honor a valid `Retry-After`; if it exceeds the configured cap, fail and report it rather than
  sleeping indefinitely.
- Parse API error `29` even if the HTTP response is successful.
- Do not implement multi-key rotation, proxy rotation, or other limit circumvention.
- Forward SIGINT/SIGTERM and caller abort through queued admission, active fetch, body reading,
  backoff, lookup, and add apply.

The default read path must not open a Lidarr connection, run a Lidarr health probe, or consult a
Lidarr circuit. The existing tier descriptor correctly marks `discovery` as not requiring the
Lidarr metadata server or a health gate. Add is a second phase: only after explicit authorization
may it resolve the Lidarr origin/client, enter the metadata-dependent lookup path, and then enter
the mutation boundary.

## Secure Coding Guidelines

1. Keep modules layered:
   `command -> discovery action -> provider facade -> Last.fm transport`. Only the transport may
   call fetch or read the API key.
2. Keep Last.fm wire types private. Public types are strict provider-neutral projections with
   explicit provenance.
3. Validate input before dynamic imports or I/O. Validate response and cached values from
   `unknown`; never use unchecked casts at a trust boundary.
4. Use immutable projected objects. Never expose the raw response, request, connection, or
   credential provider.
5. Build all errors from fixed local text plus safe numeric metadata. Never attach raw response
   text, full URLs, or credentials as `cause` when those objects can later be serialized.
6. Reject terminal controls before truncation, coloring, tables, prompts, plans, logs, and machine
   output.
7. Preserve one retry owner. Retries require an idempotent task and an explicit allowlist of
   provider failure codes.
8. Keep default discovery read-only. Put Lidarr resolution inside the explicit add branch, never
   in shared setup.
9. Do not add an artist from a Last.fm object. Resolve through Lidarr lookup, show the exact
   authoritative identity and settings, then apply a sealed intent.
10. Bind add plans to the exact Lidarr origin, plan ID, checksum, candidate provenance, and desired
    policies; revalidate before dispatch and write durable outcome history.
11. Do not cache credentials or use them in cache discriminators. Revalidate cache rows and treat
    corruption as a miss.
12. Do not add a Last.fm SDK. Use the runtime already required by the package.

Minimum security test matrix:

| Boundary        | Required tests                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration   | Template success/missing-variable failure; empty/control key rejection; unknown auth fields; config/debug redaction; wrapper re-exec; exact value absent from serialization.                                                                                                                                          |
| Transport       | Fixed HTTPS origin/path; no userinfo/fragment; redirect rejection; exact request method/headers; identifiable `User-Agent`; URL encoding; credential absent from logs/errors; timeout and caller abort; body limits; invalid UTF-8/JSON/content type.                                                                 |
| Provider errors | JSON error on HTTP 200; codes `10`, `11`, `16`, `26`, `29`; HTTP 429/5xx; missing/invalid `Retry-After`; no retry for key/input/response errors; capped abortable retry for transient errors.                                                                                                                         |
| Projection      | Empty/single/many shapes; result cap; overlong strings; ANSI/OSC/CRLF/bidi; score bounds/NaN/infinity; valid/empty/malformed MBID; duplicate identity; hostile/off-origin URL; images and unknown fields dropped.                                                                                                     |
| Output          | Human and JSON/YAML/CSV attribution parity; requested/resolved seed parity; no raw API key or full request URL; terminal-safe headings/tables/errors; provider and fetched-at always present.                                                                                                                         |
| Isolation       | Read-only command succeeds without Lidarr config; zero Lidarr fetch/health/cache calls; no mutation on provider or lookup failures; cancellation prevents later stages.                                                                                                                                               |
| Cache           | Key excludes credential; provider/method/options included; expiry and purge; header compliance; size cap; private permissions; corrupted/poisoned/mismatched provenance rejected; cache never directly authorizes add.                                                                                                |
| Add             | No implicit first-result selection; no `--add-all`; exact identity sealed; live Lidarr lookup required; Last.fm object cannot reach POST; root/profile/monitor/search policies explicit; origin/checksum/plan ID revalidation; interactive/`--yes` gate; max one; drift/duplicate/cancel/possibly-dispatched history. |
| Architecture    | Exactly one Last.fm fetch owner; action/command fetch rejected; private provider imports rejected; generated Lidarr import boundary preserved; future add mutation caller restricted to plan owner.                                                                                                                   |

Run the package unit suite, architecture suite, codegen contract suite, typecheck, build, lint, and
shell-completion parity checks because issue #203 adds a public command/option surface.

## Trade-off Recommendations

| Decision                             | Recommendation                                                                                                                     | Security rationale                                                                                                | Trade-off                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Read-only release versus bundled add | Ship read-only first unless a sealed artist-add operation can be completed in the same issue.                                      | Preserves the provider/Lidarr trust boundary and avoids an unreviewed mutation bypass.                            | Delays the convenience promised by optional `--add`, but does not block the core discovery value. |
| API-key configuration                | User-supplied environment/template key; no project-wide bundled key.                                                               | Limits blast radius, quota abuse, and suspension to the user's account and avoids publishing a shared credential. | Adds API-account setup.                                                                           |
| Provider endpoint                    | Fixed HTTPS endpoint, no production override.                                                                                      | Prevents credential forwarding, downgrade, and SSRF.                                                              | Test seams must inject fetch rather than change the URL.                                          |
| Persistent cache                     | Omit initially; add only with header-aware retention, private permissions, provenance validation, purge, and a strict size budget. | Reduces privacy and poisoning risk while traffic is one request per invocation.                                   | Repeat invocations use more provider quota.                                                       |
| SDK versus native transport          | Use native Node.js APIs.                                                                                                           | Avoids unsupported/stale SDK and transitive supply-chain risk.                                                    | Requires a small local response validator and bounded body reader.                                |
| Retry strategy                       | One owner, one normal request, provider-specific typed transient allowlist, conservative concurrency.                              | Prevents retry amplification and accidental limit abuse.                                                          | Temporary failures surface sooner.                                                                |
| Provider URLs                        | Output only validated HTTPS Last.fm catalogue links; never fetch or auto-open.                                                     | Preserves attribution without expanding network trust or handling excluded artwork.                               | No inline imagery or automatic navigation.                                                        |
| Add identity                         | Prefer MBID; when absent, require an interactive Lidarr lookup selection rather than name-only auto-selection.                     | Avoids homonym and autocorrection identity confusion.                                                             | Some candidates need an extra user choice.                                                        |

## Open Questions

1. **CRITICAL** — Is artist-add plan/apply explicitly in issue #203, including facade, operation
   definition, provenance schema, preflight, history, and confirmation, or should `--add` be moved to
   a follow-up? The generated endpoint alone is not a safe implementation.
2. **CRITICAL** — What exact Lidarr defaults are acceptable for root folder, quality profile,
   metadata profile, monitoring, album selection, and automatic search? Security recommends no
   implicit search/download and no defaults hidden from the confirmation.
3. **WARNING** — Will each installation supply its own Last.fm API key, or is a shared project key
   contemplated? A shared embedded key should be rejected.
4. **WARNING** — Does Last.fm approve the intended open-source CLI distribution and attribution
   format, particularly the Terms clauses concerning non-commercial use and public access? Obtain
   project/legal confirmation before release; this document is technical research, not legal
   advice.
5. **WARNING** — What cache directives does the live HTTPS endpoint send for representative
   success, empty, error, and rate-limit responses? Capture fixtures without credentials before
   enabling persistent caching.
6. **WARNING** — Should the Lidarr-named scheduler gain a provider-neutral retryable-error contract,
   or should the Last.fm adapter own the sole retry loop? The current scheduler will classify a
   non-Lidarr provider error as unknown and non-retryable.
7. **WARNING** — Should the shared tracking database be hardened to `0700`/`0600` for all users
   before storing discovery history, or should provider cache use a separate private store?
8. **ADVISORY** — What exact human-readable Last.fm credit text and link will appear in tables and
   machine output? It should be stable and tested across every output format.
9. **ADVISORY** — Is MBID input for the seed part of issue #203 or a follow-up? It would improve
   identity precision without needing an additional Last.fm search request.
