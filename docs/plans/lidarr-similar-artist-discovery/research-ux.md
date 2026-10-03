# UX Research: Lidarr Similar-Artist Discovery

Research date: 2026-07-25.

## Executive Summary

Issue [#203](https://github.com/yandy-r/rfmedia-apps/issues/203) should introduce one clear,
independently useful command:

```bash
rfmedia lidarr discover --artist "Radiohead"
```

The default experience is a read-only Last.fm query. It must not contact Lidarr, infer add consent,
or hide where the recommendations came from. The result should show the requested seed, any
Last.fm autocorrection, a bounded ranked list, the raw Last.fm similarity value, MusicBrainz
identity when available, and a visible `Source: Last.fm` attribution with a link. Last.fm
documents `artist.getSimilar` as accepting an artist name or MBID, an optional limit, and
autocorrection; it defines `match` as similarity from 0 to 1 and requires an API key but no user
authentication
([Last.fm `artist.getSimilar`](https://www.last.fm/api/show/artist.getSimilar), undated, accessed
2026-07-25).

The command should follow the repository's shipped Lidarr search/lookup conventions:

- human tables, warnings, attribution, and progress go to stderr;
- JSON/YAML/CSV produce exactly one deterministic machine stream on stdout;
- provider order is preserved after validation, self-removal, and deduplication;
- an empty valid result is success, while provider, credential, and malformed-response failures are
  classified failures;
- Bash, Zsh, and Fish completions expose only static flags and never make network requests.

Unlike `lidarr search`, discovery should not expose `--offset`, total, or `hasMore`.
`artist.getSimilar` documents a limit but no paging, default, maximum, total, or continuation
token. Recommend `--limit 15`, locally bounded to 100, and report only the requested limit and
returned count. The number is a product safety bound, not a provider claim.

A bare boolean `--add` is unsafe and underspecified. A discovery response contains multiple
candidates, some lack MusicBrainz IDs, and a real Lidarr add also needs root-folder, quality,
metadata, monitoring, and search policy. Issue
[#205](https://github.com/yandy-r/rfmedia-apps/issues/205) owns selection/approval, thresholds,
quarantine, diversity, and loop controls; issue
[#206](https://github.com/yandy-r/rfmedia-apps/issues/206) owns safe artist-add defaults and
post-add guardrails. The safe #203 handoff is therefore an exact, single-candidate next step:
prefer a MusicBrainz-ID-bound lookup or reviewed add plan, and do not mutate until a separate
approval boundary has resolved all policy.

**Confidence**: High. The recommendation is supported by current repository behavior, the live
issue boundaries, and primary Last.fm, Kubernetes, Terraform, and GitHub CLI documentation. The
exact numeric default and cap are Medium confidence product choices because Last.fm publishes no
maximum.

> **Freshness note (2026-07-25):** Last.fm's API and Terms of Service pages are live but undated and
> can change without a versioned API release. Recheck the method, attribution, caching, rate-limit,
> and commercial-use terms immediately before implementation is released.

## User Workflows

### Primary Flow: Read-Only Discovery

The primary workflow should be short and unsurprising:

```bash
rfmedia lidarr discover --artist "Radiohead"
```

Visible sequence:

1. Validate and normalize the artist argument and limit locally.
2. Resolve the Last.fm API key without displaying or logging it.
3. Make one cancellable `artist.getSimilar` request in the `discovery` execution lane.
4. Validate the complete provider response.
5. Remove the resolved seed from its own recommendations, deduplicate, preserve Last.fm order, and
   assign one-based ranks.
6. Render the results with attribution and stop. No Lidarr connection or mutation occurs.

Recommended human output:

```text
Similar Artists: Radiohead

  #  Artist                 Similarity  MusicBrainz ID
  1  Thom Yorke             0.821       8ed2e0b3-aa99-4e0d-b5f2-0e20199a9c44
  2  The Smile              0.793       2a86380b-912e-4e9f-9018-23243fa3c846
  3  Portishead             0.742       -

  Results: 3 returned · limit 15
  Similarity: Last.fm value from 0 (not similar) to 1 (very similar); not confidence.
  Source: Last.fm artist.getSimilar · https://www.last.fm/
  Execution: discovery lane · 1 attempt

  Next: review one exact artist with
    rfmedia lidarr lookup artist "lidarr:<MusicBrainz ID>"
  No artists were added to Lidarr.
```

Do not call the value `confidence`, `match probability`, or `recommendation quality`. Last.fm calls
it similarity and defines only the 0-to-1 endpoints
([method documentation](https://www.last.fm/api/show/artist.getSimilar), undated, accessed
2026-07-25). Show three decimal places in the human table for scanability and retain the validated
numeric value without rounding in machine output.

**Confidence**: High for flow and terminology; Medium for three-decimal human rendering because it
is a presentation choice.

### Alternate Flow: Autocorrected Seed

Last.fm supports `autocorrect=1` and says the corrected artist name is returned. Autocorrection is
helpful only when it is explicit:

```text
Similar Artists

  Requested seed: radiohed
  Resolved seed:  Radiohead (Last.fm autocorrected)
```

Machine output must preserve `requestedName`, `resolvedName`, and `autocorrected`. The user's
spelling must not be overwritten in diagnostics, cache identity, or later add review. If Last.fm
does not provide correction evidence, do not infer it from case, normalization, or string
difference.

Autocorrection is not disambiguation. Two artists can share a name, and
[`artist.search`](https://www.last.fm/api/show/artist.search) documents relevance sorting but no
exact-match or identity guarantee (undated, accessed 2026-07-25). Read-only discovery may proceed
with a visibly resolved seed; an add handoff must fail closed unless one exact MusicBrainz identity
is selected and confirmed through Lidarr.

**Confidence**: High for explicit correction evidence and add-time fail-closed behavior. Medium
for enabling autocorrection by default until a real response fixture confirms the JSON correction
shape.

### Alternate Flow: Deterministic Machine Output

JSON and YAML should serialize the same stable object, with the same property names, enum values,
ordering, nullability, and numeric semantics:

```json
{
  "command": "lidarr-discover",
  "result": {
    "seed": {
      "requestedName": "radiohed",
      "resolvedName": "Radiohead",
      "autocorrected": true
    },
    "request": {
      "limit": 15
    },
    "returned": 2,
    "recommendations": [
      {
        "rank": 1,
        "name": "Thom Yorke",
        "similarity": 0.821,
        "musicBrainzId": "8ed2e0b3-aa99-4e0d-b5f2-0e20199a9c44",
        "sourceUrl": "https://www.last.fm/music/Thom+Yorke",
        "addEligibility": "exact-id"
      },
      {
        "rank": 2,
        "name": "Portishead",
        "similarity": 0.742,
        "musicBrainzId": null,
        "sourceUrl": "https://www.last.fm/music/Portishead",
        "addEligibility": "requires-resolution"
      }
    ],
    "source": {
      "provider": "lastfm",
      "method": "artist.getSimilar",
      "attribution": "Recommendations provided by Last.fm",
      "url": "https://www.last.fm/"
    },
    "handoff": {
      "status": "not-requested"
    },
    "execution": {
      "taskId": "lidarr-discover",
      "operation": "lidarr discover",
      "lane": "discovery",
      "outcome": "succeeded",
      "attempts": 1
    }
  }
}
```

Recommendations remain in provider order; rank is assigned after validation and deduplication.
Never sort ties by name, locale, or MBID. Use explicit `null` for missing optional identity/link
fields if the schema adopts the example above; if repository maintainers choose omission instead,
that omission rule must be identical in JSON and YAML and contract-tested. Do not include
provider-returned images, biographies, arbitrary tags, raw response bodies, request URLs, or API
keys.

CSV should use a fixed ordered column list. Emit one `summary` row even for zero recommendations,
followed by `recommendation` rows:

```text
command,rowType,seed.requestedName,seed.resolvedName,seed.autocorrected,request.limit,returned,source.provider,source.method,source.url,execution.lane,execution.outcome,execution.attempts,recommendation.rank,recommendation.name,recommendation.similarity,recommendation.musicBrainzId,recommendation.sourceUrl,recommendation.addEligibility
```

The summary row owns seed, request, source, count, handoff, and execution fields. Candidate rows own
recommendation fields. Use the existing CSV formula neutralization. A valid empty result is still a
parseable one-row CSV stream rather than an empty file.

This mirrors the repository's current `lidarr-search` projection while following Kubernetes'
official advice to request an explicit machine-oriented format for reusable scripts
([kubectl usage conventions](https://kubernetes.io/docs/reference/kubectl/conventions/), last
modified 2026-05-15, accessed 2026-07-25).

**Confidence**: High. These are direct extensions of the shipped output boundary and fixed CSV
contract.

### Alternate Flow: Explicit Safe Handoff Toward Lidarr

Discovery should help the user continue without conflating recommendation with consent.

For a recommendation with a valid MusicBrainz ID:

```text
  Candidate 1 is eligible for exact Lidarr resolution.
  Next: rfmedia lidarr lookup artist \
    "lidarr:8ed2e0b3-aa99-4e0d-b5f2-0e20199a9c44"
```

For a recommendation without an MBID:

```text
  Candidate 3 needs identity resolution before it can be added.
  Next: rfmedia lidarr lookup artist "Portishead"
  Review all matches; name alone is not an add identity.
```

If #203 must offer an add-related flag, it should create or display a single-target handoff rather
than perform an implicit mutation. Acceptable shapes include
`--prepare-add <musicbrainz-id>` or a separate future
`lidarr add artist --mbid <id>`/plan command. A same-command mutation shape would need at least an
exact candidate selector plus complete add policy and a second confirmation:

```text
rfmedia lidarr discover --artist "Radiohead" \
  --add <exact-candidate-id> <explicit-policy-options>
```

It must not interpret `--add` as "add every result" or "add rank 1". Rank is response-local and
name is not durable identity. A candidate's `addEligibility` is information, not consent.

Terraform provides a useful comparable boundary: it separates reviewable plans from apply,
prompts before an automatically generated plan is executed, and requires explicit automation
approval when interactive input is disabled
([Terraform `apply`](https://developer.hashicorp.com/terraform/cli/commands/apply), v1.15
documentation, accessed 2026-07-25). rfmedia's existing Lidarr plan/apply behavior already follows
that pattern.

**Confidence**: High that a bare `--add` is ambiguous; Medium on the eventual exact handoff command
name because #203, #205, and #206 have not yet chosen one shared mutation grammar.

### Recovery Flow: Seed Resolution Is Ambiguous

There are two distinct ambiguity points:

1. **Before discovery**: a same-name seed may identify more than one artist. Default direct
   discovery can only state which name Last.fm used; it cannot claim durable identity.
2. **Before add**: a recommendation name or missing MBID may resolve to zero or multiple Lidarr
   lookup candidates. No mutation may occur until the operator chooses one exact MusicBrainz ID.

Interactive seed selection, if later added, should use a bounded numbered list containing artist
name, MBID, and provider link, then echo the selected identity before querying similar artists.
Non-interactive use must never select result zero automatically. It should require an exact seed
selector or fail with structured candidates. Adding this extra `artist.search` call to every
ordinary invocation is not recommended: `artist.getSimilar` already accepts the seed name, and the
search endpoint does not guarantee identity.

**Confidence**: High.

### Recovery Flow: No Recommendations

A structurally valid provider response with no recommendations is a successful read:

```text
No similar artists found for "Example Artist".
Source: Last.fm artist.getSimilar · https://www.last.fm/
No artists were added to Lidarr.
```

Exit 0 and emit the normal machine envelope with `returned: 0` and
`recommendations: []`. Do not call an unknown seed, error object, malformed response, or outage
"no results." Because no total is documented, do not say "0 of 0" or offer `--offset`.

**Confidence**: High.

## CLI UX Best Practices

### Command Grammar and Help

Recommended initial surface:

```text
rfmedia lidarr discover --artist <name> [--limit <n>]
```

- `--artist` is required exactly once and accepts one bounded terminal-safe name.
- `--limit` defaults to 15 and accepts integers from 1 through 100.
- Global `--json`, `--output json|yaml|csv|table|text`, `--verbose`, `--debug`, and color behavior
  retain their current meanings.
- Last.fm credentials should normally come from config/environment templates. If an explicit
  `--lastfm-api-key` exists, help must mark it sensitive and failure reporting must redact it.
- Ordinary discovery must not require or initialize `--lidarr-url` or `--lidarr-api-key`.
- Do not add `--offset`, `--page`, `--deep`, score thresholds, diversity controls, multi-seed
  input, or `--source`; those are either unsupported by the method or owned by #204/#205.

Help text should say `Discover similar artists from Last.fm (read-only)` rather than the vague
`Discover artists`. The leaf help should include one human example and one machine-output example,
and state that no artists are added by default.

Bash, Zsh, and Fish completions must all add `discover`, `--artist`, and `--limit` with exact
descriptions, plus any deliberately accepted Last.fm credential flag. Do not network-complete
artist names, MBIDs, or recommendation ranks. The repository's completion parity test is part of
the public CLI contract.

**Confidence**: High, except the credential flag choice, which is Medium pending configuration
design.

### Human Output

- Human output stays on stderr, matching current Lidarr table commands.
- Keep the default table to the requested shallow limit; no internal pager or interactive
  full-screen UI.
- Essential columns are rank, artist, similarity, and MBID. Put provider URLs in machine output
  and attribution rather than widening every row.
- On narrow terminals, omit/truncate MBID display before making the artist name unreadable; never
  truncate the machine value.
- Never rely on color alone. Labels such as `autocorrected`, `rate-limited`, `cached`,
  `requires-resolution`, and `read-only` must remain visible with color disabled.
- Print attribution on every successful human result, including empty and cached results.
- Print `No artists were added to Lidarr` in the first release to make the safety boundary
  unmistakable.

**Confidence**: High.

### Machine Output and Automation Safety

- Successful JSON/YAML/CSV writes one valid document or stream to stdout.
- Progress, retry notices, attribution prose, warnings, and diagnostics stay on stderr.
- Machine format does not imply consent to add and must not trigger a prompt.
- If a future add operation is requested in a non-TTY or machine format, it must require an exact
  selector, all unresolved policy, and explicit `--yes`; otherwise it fails before mutation.
- Stable failure output retains command ID, provider, error code, lane, attempts, retryability,
  status code where safe, and retry timing. It never includes the API key, raw request URL, or raw
  provider body.
- Success is exit 0, ordinary failure is nonzero, and Ctrl-C is distinct from a valid no-result or
  declined confirmation. GitHub CLI uses exit 2 for cancellation
  ([GitHub CLI exit codes](https://cli.github.com/manual/gh_help_exit-codes), current manual,
  accessed 2026-07-25), but rfmedia should adopt a special code only as a repository-wide policy,
  not as an isolated #203 exception.

Kubernetes explicitly recommends machine formats and avoiding implicit context for scripts
([kubectl usage conventions](https://kubernetes.io/docs/reference/kubectl/conventions/), last
modified 2026-05-15). The same principle means every add-relevant identity and policy must be
explicit in non-interactive rfmedia use.

**Confidence**: High for stream and consent boundaries; Medium for a dedicated cancellation exit
code.

### Source Attribution and Links

Every format must identify:

- provider: `lastfm`;
- method: `artist.getSimilar`;
- credit: `Recommendations provided by Last.fm`;
- provider URL: `https://www.last.fm/`;
- per-candidate Last.fm catalogue URL when returned and validated.

Last.fm's current Terms require credit and links when its data is used, and call for artist data
links to point to the applicable Last.fm catalogue page
([Last.fm API Terms of Service](https://www.last.fm/api/tos), clauses 2.7 and 4.2, undated,
accessed 2026-07-25). The Terms describe web-page button/link placement, not a terminal-specific
equivalent. Plain text plus an HTTPS link is the practical CLI treatment, but release/legal review
should confirm that it is acceptable and whether brand approval is required.

Do not display a Last.fm logo as terminal art or imply endorsement. Do not call the results
`rfmedia recommendations`; retain provider ownership in the label.

**Confidence**: High that credit and links are required; Low-to-Medium that the proposed terminal
text alone satisfies every brand-placement clause because Last.fm does not document a CLI-specific
form.

### Limit, Paging, and Similarity Presentation

| UX concept    | Recommendation                                       | Rationale                                                                         |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Default limit | 15                                                   | Reviewable first screen; aligns with the product goal of 10–15 useful candidates. |
| Maximum limit | 100                                                  | Conservative local bound; not represented as a Last.fm limit.                     |
| Offset/page   | Do not expose                                        | `artist.getSimilar` documents neither control.                                    |
| Total/hasMore | Do not emit                                          | The response contract does not establish either value.                            |
| Ordering      | Preserve provider order                              | Avoid inventing a second recommendation algorithm.                                |
| Similarity    | Human: three decimals; machine: validated raw number | Retains provider semantics without false precision claims in prose.               |
| Confidence    | Never label similarity as confidence                 | Similarity is not identity, quality, availability, or add safety.                 |
| Threshold     | Defer to #205                                        | Threshold policy changes which recommendations are visible.                       |

The `artist.getSimilar` page documents `limit` and the similarity range but no pagination or
maximum ([Last.fm method documentation](https://www.last.fm/api/show/artist.getSimilar), undated,
accessed 2026-07-25).

**Confidence**: High for the unsupported-field exclusions; Medium for the local numeric choices.

## Error Handling

| State                                                     | Human treatment                                                                      | Machine treatment                                             | Exit/recovery                                    | Confidence                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------ | -------------------------------- |
| Missing, repeated, empty, unsafe, or oversized `--artist` | Name the invalid argument and accepted shape; no I/O                                 | `code: validation`, no secret or request data                 | Nonzero; correct the flag                        | High                             |
| Invalid `--limit`                                         | `--limit must be an integer from 1 to 100`                                           | `code: validation` with safe field name                       | Nonzero; no I/O                                  | High                             |
| Missing Last.fm key                                       | Explain the expected config/template variable without echoing values                 | `code: configuration`, `provider: lastfm`                     | Nonzero; configure key                           | High                             |
| Invalid or suspended key (Last.fm 10/26)                  | `Last.fm API key is invalid` or `suspended`; no retries                              | Stable auth/config code; attempts reported                    | Nonzero; replace/contact provider                | High                             |
| Unknown/unresolved seed (provider error 6/7)              | Distinguish from empty recommendations; suggest checking spelling or exact seed mode | Provider/input code with requested seed                       | Nonzero; revise/resolve seed                     | Medium                           |
| Valid zero recommendations                                | Attributed empty state; state no add occurred                                        | Normal success envelope with empty array                      | 0; choose another seed                           | High                             |
| Rate limit (Last.fm 29)                                   | `Last.fm rate limit exceeded`; show retry delay only when actually supplied          | `code: rate-limited`, retryable, optional `retryAfterSeconds` | Nonzero after bounded retry; retry later         | High for code, Medium for timing |
| Temporary outage (Last.fm 11/16)                          | Name Last.fm, show attempts, suggest retry later                                     | Provider-unavailable code and discovery-lane metadata         | Nonzero after bounded retries                    | High                             |
| Transport timeout/DNS/TLS failure                         | Name operation/provider, not credentials or full URL                                 | Classified transport code; retryability                       | Nonzero after bounded policy                     | High                             |
| Malformed success payload                                 | `Last.fm returned an invalid response`; do not show partial ranking                  | `code: malformed-response`; no raw body                       | Nonzero; report/retry later                      | High                             |
| Cached response, if implemented                           | `Showing Last.fm data cached <age> ago`; always retain attribution                   | Source, freshness, fetched-at, age, and degraded fields       | 0 only under explicit policy/consent             | Medium                           |
| Ctrl-C before/during request                              | `Discovery cancelled; no artists were added`                                         | Cancellation code/envelope if output can remain valid         | Nonzero; never retry or hand off                 | High                             |
| Bare `--add`                                              | Explain that one exact candidate and add policy are required                         | `code: ambiguous-add-intent`                                  | Nonzero; choose exact ID/handoff                 | High                             |
| Candidate missing MBID                                    | Mark `requires-resolution`; discovery still succeeds                                 | `addEligibility: requires-resolution`                         | 0 for discovery; exact lookup before add         | High                             |
| Multiple Lidarr lookup matches                            | Show bounded identities; never auto-select first                                     | Separate handoff status `blocked` with candidates             | Nonzero for requested handoff; select exact MBID | High                             |
| Candidate already in Lidarr                               | `Already present; no add was attempted`                                              | Handoff status `already-present`                              | 0, idempotent no-op                              | High                             |
| Lidarr unavailable during handoff                         | Preserve discovery results; report handoff failure separately                        | Discovery success plus `handoff.status: failed`               | Nonzero if add was requested; retry handoff      | High                             |
| Cancellation after add dispatch                           | Do not claim rollback or absence; reconcile fresh state                              | Handoff status `uncertain` until verified                     | Nonzero; no automatic replay                     | High                             |

Last.fm documents errors 10, 11, 16, 26, and 29 on the
[`artist.getSimilar`](https://www.last.fm/api/show/artist.getSimilar) page (undated, accessed
2026-07-25). Its Terms say rate limits are discretionary and must not be circumvented
([Last.fm API Terms](https://www.last.fm/api/tos), clause 4.4, undated, accessed 2026-07-25).

**Confidence**: High overall. Cached-result exit behavior is Medium because #203 has not decided
whether provider caching/stale serving is user-visible.

## Performance UX

### Latency and Progress

The normal command should make one provider request. Do not preflight Lidarr or call
`artist.search`/`artist.getInfo` on every invocation. This keeps the read path fast and preserves
the issue's independence from Lidarr.

For a fast response, render no spinner. If the request crosses a short interactive threshold,
print one stable stderr status such as `Fetching similar artists from Last.fm…`; clear or terminate
it before the table. Non-TTY and machine output should be silent unless a retry or warning is
actionable. Do not stream candidates before the complete response is validated because partial
output would make provider order, deduplication, and final counts unstable.

**Confidence**: High for one-request and atomic-output behavior; Medium for the exact progress
threshold.

### Retry, Rate-Limit, and Outage Feedback

The repository's discovery lane currently provides bounded concurrency, retries, and backoff.
Human output should avoid noisy per-attempt logs by default. After a retryable failure, one concise
line may say `Retrying Last.fm (attempt 2 of 3)…`. If a valid provider delay is available, show it;
otherwise do not fabricate a countdown.

Last.fm asks clients not to make excessive calls and warns that continuously making several calls
per second can lead to suspension
([Last.fm API introduction](https://www.last.fm/api/intro), undated, accessed 2026-07-25). Its
Terms require caching in accordance with response headers and impose a 100 MB retained-data cap
([Last.fm API Terms](https://www.last.fm/api/tos), clause 4.3.4, undated, accessed 2026-07-25).
Consequently:

- no automatic provider fan-out in #203;
- no busy retry loop;
- no hidden Lidarr or alternative-provider fallback;
- no persistent cache TTL invented without observing response headers;
- any cached result carries provider, age, freshness, and degradation evidence.

**Confidence**: High for the usage constraints; Medium for cache UX until actual response headers
are characterized.

### Cancellation

The request and scheduler task must share one `AbortSignal`. Ctrl-C before admission prevents the
request; Ctrl-C during fetch aborts it; cancellation is never retried and never falls through to an
add path. If a future same-command handoff exists, cancellation before mutation states that no
change occurred. Cancellation after an add may have been dispatched is an uncertain mutation and
requires fresh Lidarr reconciliation.

Node documents `AbortSignal` as the signal used to communicate cancellation to APIs
([Node.js globals: `AbortSignal`](https://nodejs.org/api/globals.html#class-abortsignal), current
documentation, accessed 2026-07-25).

**Confidence**: High.

## Competitive/Comparable Analysis

| Product/pattern                        | Useful behavior                                                                                                                     | Limitation or lesson for #203                                                                                   | Confidence |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| Current `rfmedia lidarr search/lookup` | Ranked table, explicit provider line, execution lane, fixed CSV summary/record rows, stdout/stderr separation, bounded limit/offset | Discovery can reuse presentation contracts but must not copy paging fields unsupported by Last.fm               | High       |
| Last.fm `artist.getSimilar`            | Direct name/MBID seed, autocorrection, ranked candidates, 0–1 similarity, provider catalogue URLs                                   | It does not prove durable identity, publish paging/total, or define score as confidence                         | High       |
| Last.fm `artist.search`                | Paged relevance candidates can support an explicit selection UI                                                                     | Result zero is not documented as an identity match; adding it to every request increases latency and traffic    | High       |
| Terraform plan/apply                   | Separates review from mutation; prompts by default; explicit non-interactive approval                                               | Saved plans can contain sensitive data, so any rfmedia handoff artifact must be narrow and treated as sensitive | High       |
| Kubernetes `kubectl`                   | Human default plus explicit machine formats for scripts; guidance warns against implicit context                                    | rfmedia machine output should make provider, seed, limit, identity, and handoff status explicit                 | High       |
| GitHub CLI exit model                  | Separates success, ordinary failure, cancellation, and authentication                                                               | rfmedia should distinguish cancellation semantically, but a numeric code change should be repository-wide       | Medium     |
| Lidarr add API boundary                | Fresh Lidarr lookup can provide canonical artist identity and writable add resource                                                 | Recommendation data alone is insufficient; policy and side effects make direct Last.fm-to-add unsafe            | High       |

The most important comparison is internal, not competitive: discovery is a different provider
contract behind the same CLI trust boundary. Reuse the output and error grammar while keeping
Last.fm provenance and unsupported paging semantics honest.

**Confidence**: High.

## Recommendations

### Must Have

1. Ship `rfmedia lidarr discover --artist <name>` as read-only by default, with no Lidarr
   dependency or mutation.
2. Validate one terminal-safe artist seed and a locally bounded `--limit` before any I/O.
3. Call only Last.fm `artist.getSimilar` for the default flow and visibly preserve requested versus
   autocorrected seed.
4. Preserve Last.fm order, remove the seed, deduplicate deterministically, assign one-based rank,
   and expose similarity as a 0-to-1 Last.fm value rather than confidence.
5. Include Last.fm attribution and links in human, JSON, YAML, CSV, empty, cached, and error
   contexts where provider data is used.
6. Match repository stream discipline: human output on stderr; exactly one structured machine
   stream on stdout; no ANSI or logs in machine output.
7. Use a fixed JSON/YAML contract and summary-plus-recommendation CSV columns, including a summary
   row for zero results.
8. Do not expose fake pagination, total, or `hasMore`; `artist.getSimilar` documents only a limit.
9. Classify empty, unknown seed, invalid/suspended key, rate-limit, outage, timeout, malformed
   response, and cancellation distinctly.
10. Reject a bare `--add`. Require one exact candidate identity and a separately reviewed mutation
    boundary with all add policy resolved.
11. Preserve a successful recommendation set when a requested Lidarr handoff fails; discovery and
    handoff are separate outcomes.
12. Update and contract-test Bash, Zsh, and Fish completions without network-backed completion.

**Confidence**: High.

### Should Have

1. Default `--limit` to 15 and cap it at 100, clearly labeling the cap as local policy.
2. Enable Last.fm autocorrection only with explicit correction evidence in output and fixtures.
3. Include `addEligibility: exact-id|requires-resolution` without presenting eligibility as
   consent.
4. Print a safe exact next command using the candidate MBID, or a quoted name with an ambiguity
   warning when no MBID exists.
5. Provide one delayed-request progress line only on interactive stderr and concise bounded retry
   feedback.
6. Treat Ctrl-C as a distinct cancellation state; decide a dedicated numeric exit code centrally.
7. Record source freshness/degradation if response-header-compliant caching is implemented.
8. Verify terminal attribution/brand treatment and intended commercial/non-commercial usage before
   release.

**Confidence**: High except the numeric defaults, progress threshold, and legal/brand sufficiency,
which are Medium or lower as noted above.

### Nice to Have

1. An opt-in strict seed-resolution flow that calls `artist.search`, shows bounded candidates, and
   requires selection before discovery.
2. A copy-friendly compact output mode containing MBID and name, implemented as an explicit stable
   machine projection rather than parsing the human table.
3. Display-width-aware optional-column suppression for very narrow terminals.
4. A reviewed single-target handoff artifact once #205/#206 establish the shared add policy and
   approval grammar.

Multi-provider federation, `--source`, Plex-derived seeds, recursive discovery, thresholds,
diversity/popularity tuning, quarantine, automatic bulk add, and post-add normalization are not
nice-to-have #203 polish; they belong to #204, #205, or #206.

**Confidence**: Medium. These improve usability but are not required for a safe first release.

## Open Questions

1. Does #203 satisfy its optional add requirement by emitting an exact reviewed handoff/plan, or
   must it perform a real artist POST? A real POST necessarily consumes unresolved #206 policy.
2. What shared syntax should select one candidate: exact MBID, an opaque candidate token, or a
   separate `lidarr add artist` command? A bare boolean and replayed rank should be ruled out.
3. Are default 15 and maximum 100 accepted? Last.fm documents neither a default nor maximum.
4. Should `autocorrect=1` be the default, and what exact live JSON fields prove correction?
5. Should name-only read discovery be allowed to proceed when the seed may be ambiguous, or should
   a future strict mode require explicit seed resolution?
6. Should missing-MBID recommendations show a lookup next step or simply be marked non-addable in
   #203?
7. Should the schema use explicit `null` or omission for absent MBID/source URL? Choose once and
   test exact JSON/YAML parity.
8. Is `addEligibility` part of #203's stable machine contract, or should the handoff layer derive it
   from `musicBrainzId`?
9. What Last.fm response headers are observed in production, and do they permit a useful cache or
   stale fallback? Do not decide a TTL before measuring them.
10. Does intended distribution comply with Last.fm's current non-commercial licence, attribution
    and link placement, brand approval, 100 MB cap, and artwork exclusion?
11. Should the repository add a provider-neutral `discovery-provider-unavailable` error code rather
    than reuse `metadata-provider-unavailable`?
12. Should rfmedia standardize exit 2 for user cancellation, or retain nonzero 1 for compatibility?

## Sources

- [GitHub issue #203](https://github.com/yandy-r/rfmedia-apps/issues/203), current issue body,
  accessed 2026-07-25.
- [GitHub issue #204](https://github.com/yandy-r/rfmedia-apps/issues/204), current issue body,
  accessed 2026-07-25.
- [GitHub issue #205](https://github.com/yandy-r/rfmedia-apps/issues/205), current issue body,
  accessed 2026-07-25.
- [GitHub issue #206](https://github.com/yandy-r/rfmedia-apps/issues/206), current issue body,
  accessed 2026-07-25.
- [Last.fm `artist.getSimilar`](https://www.last.fm/api/show/artist.getSimilar), undated live API
  documentation, accessed 2026-07-25.
- [Last.fm `artist.search`](https://www.last.fm/api/show/artist.search), undated live API
  documentation, accessed 2026-07-25.
- [Last.fm API introduction](https://www.last.fm/api/intro), undated live documentation, accessed
  2026-07-25.
- [Last.fm API Terms of Service](https://www.last.fm/api/tos), undated live terms, accessed
  2026-07-25.
- [Kubernetes kubectl usage conventions](https://kubernetes.io/docs/reference/kubectl/conventions/),
  last modified 2026-05-15, accessed 2026-07-25.
- [Terraform `apply` command](https://developer.hashicorp.com/terraform/cli/commands/apply), v1.15
  documentation with no page publication date, accessed 2026-07-25.
- [GitHub CLI exit codes](https://cli.github.com/manual/gh_help_exit-codes), current manual with no
  page publication date, accessed 2026-07-25.
- [Node.js globals: `AbortSignal`](https://nodejs.org/api/globals.html#class-abortsignal), current
  documentation with no page publication date, accessed 2026-07-25.
- Current repository
  [`packages/rfmedia-cli/src/commands/lidarr-search.ts`](../../../packages/rfmedia-cli/src/commands/lidarr-search.ts),
  [`packages/rfmedia-cli/src/commands/lidarr.ts`](../../../packages/rfmedia-cli/src/commands/lidarr.ts),
  formatter, scheduler, prompt, error, and Bash/Zsh/Fish completion code; inspected 2026-07-25.
