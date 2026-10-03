# Business Research — Lidarr Similar-Artist Discovery

## Executive Summary

Issue [#203](https://github.com/yandy-r/rfmedia-apps/issues/203) should add one independently useful,
read-only workflow:

```bash
rfmedia lidarr discover --artist "Radiohead"
```

The command asks Last.fm for similar artists, preserves Last.fm's recommendation order and
similarity evidence, and identifies Last.fm in every human and machine result. It must run in the
already-shipped `discovery` execution lane and must not contact Lidarr, Lidarr's metadata service,
MusicBrainz, ListenBrainz, or Plex merely to produce recommendations. This separation is the
central business value: discovery remains available even when Lidarr or its metadata dependency is
unavailable.

Discovery is read-only by default and must never add every returned recommendation. Issue #203
also requires an optional, explicit add-to-Lidarr handoff, but the current repository has no
artist-add facade method or plan operation, and a valid Lidarr artist add needs more than a Last.fm
name: an unambiguous Lidarr lookup result, root folder, quality profile, metadata profile, monitoring
policy, and search behavior. Therefore the safe baseline is a two-step contract:

1. discovery returns bounded, attributed candidates; and
2. the operator explicitly selects one or more exact candidates for a reviewed Lidarr add step.

A bare `--add` against a multi-result response is not a safe selector and must be rejected. The add
step must use the shipped plan/apply boundary or an equivalently explicit single-target review and
approval gate. If #203 is expected to perform an immediate `POST /api/v1/artist`, the minimum safe
defaults and configuration decisions from [#206](https://github.com/yandy-r/rfmedia-apps/issues/206)
must be pulled into #203 deliberately; they cannot be inferred from current code.

### Scope Boundary

| Classification            | Capability                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required by #203          | One artist-name seed, Last.fm `artist.getSimilar`, read-only default, bounded results, similarity evidence, source attribution, stable human and machine output, discovery-lane execution, and an explicit add handoff |
| Necessary supporting work | Last.fm API-key configuration/redaction, strict response projection, provider-specific failure mapping, cancellation, terms-compliant attribution, shell-completion parity, docs, and tests                            |
| Explicitly not #203       | Provider selection, ListenBrainz, MusicBrainz relationships, Plex seeds, weighted merging, federated ranking, and `--source ...`; these belong to [#204](https://github.com/yandy-r/rfmedia-apps/issues/204)           |
| Follow-up safety work     | Quarantine, thresholds, diversity controls, multiple hops, `--deep`, `--max-add`, `--max-per-seed`, and loop prevention belong to [#205](https://github.com/yandy-r/rfmedia-apps/issues/205)                           |
| Follow-up add policy      | General add defaults, profile/root selection policy, unmonitored defaults, search-disabled defaults, and post-add normalization belong to #206                                                                         |
| Follow-up impact analysis | Indexer/download cascade estimates and budgets belong to [#219](https://github.com/yandy-r/rfmedia-apps/issues/219)                                                                                                    |

Issue #204 may later replace the single-source internals with a provider abstraction, but #203
must not pre-implement a registry, aggregation algorithm, provider weights, or alternate providers.
The #203 result should nevertheless carry an explicit `source` object so adding sources later does
not require removing provenance or changing the meaning of existing Last.fm fields.

## User Stories

- As a music-library operator, I can discover artists related to one named seed without opening the
  Lidarr UI or depending on Lidarr's metadata service.
- As an operator during a Lidarr outage, I can still receive Last.fm recommendations; only the
  optional Lidarr handoff is unavailable.
- As a cautious operator, running discovery without an explicit add choice cannot change Lidarr,
  monitoring state, download queues, indexer traffic, or local files.
- As an operator, I can see the seed name Last.fm actually used when Last.fm autocorrected my input.
- As an operator, I can see Last.fm's similarity value and source link rather than being shown an
  unexplained rfmedia recommendation.
- As automation, I receive deterministic ranks, bounded candidate fields, source identity,
  execution metadata, and stable error codes in JSON, YAML, and CSV.
- As automation, I can distinguish no recommendations from a malformed response, invalid API key,
  provider outage, provider rate limit, timeout, cancellation, or local configuration error.
- As a user who wants one recommendation in Lidarr, I can explicitly select an exact candidate and
  review the resolved Lidarr target and add policy before any write.
- As a user facing an ambiguous or missing MusicBrainz ID, I am asked to resolve the candidate
  instead of rfmedia adding an artist based only on a display name.
- As a security-conscious operator, the Last.fm API key never appears in process output, logs,
  errors, cache keys, source URLs, plan artifacts, or serialized results.
- As a maintainer, I can test Last.fm discovery without a live provider and without exposing raw
  response objects above the provider boundary.
- As a future #204 maintainer, I can add federated providers without changing the meaning of
  `source.provider: "lastfm"` or treating single-source ranks as cross-provider scores.

## Business Rules and Edge Cases

### Command and Input Contract

1. The issue-required entry point is exactly `rfmedia lidarr discover --artist <name>`.
2. `--artist` is required exactly once. An omitted, repeated, empty, or whitespace-only value fails
   locally before provider, scheduler, cache, or Lidarr I/O.
3. Reuse the shipped search-term safety contract unless external validation proves Last.fm needs a
   narrower bound:
   - outer-trim and NFC-normalize;
   - retain internal whitespace and case;
   - accept 1–256 Unicode code points and at most 1,024 UTF-8 bytes; and
   - reject C0/C1 controls, NUL, DEL, and Unicode bidi controls.
4. The primary input is an artist name. MusicBrainz-ID seed input, Plex seed input, playlists,
   multiple seeds, and recursive discovery are not implied by #203.
5. Recommend `--limit <n>` with a shallow default of 15 and a hard maximum of 100. The default
   reflects the repository research recommendation to show 10–15 useful candidates rather than an
   unreviewable popularity-biased list. The maximum aligns with the discovery lane's current
   operation budget and is a local safety bound, not a claim about Last.fm's undocumented maximum.
6. `--deep`, minimum-score thresholds, diversity/popularity adjustments, and multi-hop depth are
   intentionally absent until #205.
7. Connection options for Lidarr are irrelevant to a read-only discovery. Supplying
   `--lidarr-url` or `--lidarr-api-key` should be accepted only by an explicit add step, never
   required by ordinary discovery.
8. Last.fm credential precedence should mirror existing connection patterns: explicit CLI
   override, validated config value/template, then a documented environment-backed template.
   The exact config path and whether a `--lastfm-api-key` flag is desirable remain open decisions.
9. The Last.fm key is required for `artist.getSimilar`, but the method itself does not require a
   user session. rfmedia must not request or store a Last.fm account password, session key, or API
   secret for this read-only method.

### Last.fm Request Contract

1. #203 calls only the documented Last.fm `artist.getSimilar` method over HTTPS with JSON output.
2. The request contains only the normalized artist name, bounded limit, API key, output format, and
   a deliberate autocorrect choice. It sends no Lidarr or Plex credentials.
3. Recommend `autocorrect=1` for user value, provided output always reports:
   - the normalized requested seed;
   - the resolved seed name returned by Last.fm; and
   - whether correction occurred.

4. An undocumented or missing correction field must not be guessed. If the response does not
   identify a correction, `autocorrected` is omitted or false according to the chosen schema.
5. Follow redirects only under a strict origin policy. A redirect must never forward the API key to
   a non-Last.fm host.
6. The request must honor the command's abort signal and a bounded timeout. Aborted work is not
   retried and never enters an add path.
7. Last.fm documents error 29 as rate limiting; errors 11 and 16 are temporary service failures;
   errors 10 and 26 indicate invalid/suspended keys; errors 6 and 7 represent invalid or unresolved
   input/resource cases. These must be classified, not flattened into “no results.”
8. A transport `200` containing a Last.fm error object is a provider failure, not a successful
   empty recommendation list.

### Recommendation Identity, Ranking, and Projection

1. Preserve Last.fm's order. The upstream `match` value is a similarity signal, not an rfmedia
   score and not a promise of quality, novelty, availability, or compatibility with the user's
   library.
2. Assign one-based `rank` after validation and deduplication.
3. Deduplicate first by valid MusicBrainz artist ID when present, otherwise by an explicitly
   documented normalized `(provider, artist name)` fallback. First occurrence wins.
4. Exclude an exact seed self-match after applying the same identity rules. A corrected seed must
   be compared using the resolved identity/name.
5. Every candidate must have:
   - `rank`;
   - a non-empty, bounded, terminal-safe `name`;
   - finite `similarity` from 0 through 1; and
   - Last.fm source attribution.

6. `musicBrainzId` is optional because Last.fm may return an empty ID. When present it must be one
   valid UUID and should be canonicalized to lowercase.
7. `sourceUrl` is optional only if Last.fm omits it. When present it must be a bounded HTTPS Last.fm
   URL and must not contain an API key or other credential.
8. Do not expose Last.fm image URLs or artwork in #203. The current Last.fm terms exclude artwork
   from the API data license, and images add no essential CLI value.
9. Do not copy raw provider objects, arbitrary tags, biographies, HTML, or error bodies into domain
   results. Project fresh, bounded objects and reject unsafe collection or string shapes.
10. Recommend rejecting the complete provider response atomically if required fields, similarity
    values, or collection bounds are invalid. Partial output would make provider ranking and counts
    misleading.
11. A valid response with zero candidates succeeds with exit code 0 and `recommendations: []`.
    It is distinct from unknown seed/provider error unless Last.fm's documented response proves
    they are equivalent.
12. #203 does not re-rank based on whether an artist already exists in Lidarr. Ordinary discovery
    cannot know that without violating the independent-of-Lidarr requirement.

### Read-Only Default and Add Handoff

1. Ordinary discovery performs zero Lidarr calls and zero mutations.
2. It must not add artists, monitor artists/albums, trigger searches, refresh metadata, create
   tags, change profiles, enqueue downloads, or write local media files.
3. It must not silently interpret a high similarity score as consent.
4. It must not interpret all returned candidates as add targets.
5. A bare boolean `--add` is insufficient when discovery returns multiple candidates. The command
   must require an explicit candidate selector, preferably a MusicBrainz ID or another exact
   candidate token bound to the just-reviewed result.
6. Rank alone is not a durable add identity. It may be accepted only within a single interactive
   review whose candidate set and source response are still visible; it must not be persisted or
   replayed as the target identity.
7. A candidate with no valid MusicBrainz ID is discoverable but not automatically addable. The add
   handoff must first resolve it through the shipped typed `lidarr lookup artist` boundary. Zero or
   multiple valid lookup matches block addition and present the choices.
8. Last.fm identity never goes directly to Lidarr's add endpoint. The add target is the fresh,
   validated Lidarr lookup projection and its MusicBrainz ID.
9. Already-present candidates are successful no-ops. The result must say `already-present` and
   make no POST request.
10. A real add must disclose and bind all required policy:
    - root folder;
    - quality profile;
    - metadata profile;
    - artist/albums monitoring;
    - monitor-new-items behavior; and
    - whether Lidarr searches for missing albums.

11. No current config or public domain type supplies those defaults. Missing or ambiguous policy
    fails closed; rfmedia must not forward generated DTO defaults.
12. The safest #203 integration is an exact single-artist add plan or handoff artifact followed by
    `lidarr apply`. Plan creation may resolve fresh Lidarr state but does not mutate.
13. If the product instead retains a same-command `--add <candidate>` workflow, real mutation still
    requires a second confirmation/`--yes` gate and must show the exact resolved artist and full add
    policy. Machine mode must require `--yes`.
14. Do not place add work in the `discovery` lane. Last.fm lookup is `discovery`; Lidarr lookup is
    `metadata-dependent`; an actual non-idempotent artist add belongs behind the mutation safety
    boundary with no automatic replay after uncertain dispatch.
15. A successful discovery followed by a failed add is a partial workflow, not a failed discovery.
    Machine output must preserve the recommendations and report the handoff/add outcome separately.
16. Persistent deferred addition is not automatically safe. The existing deferred queue does not
    support artist-add, and replaying a stale add without revalidating profiles, root folder,
    identity, and already-present state could produce unwanted cascades.
17. General bulk add, automatic add-all, safe default policies, post-add normalization, and
    acquisition controls remain #205/#206 work.

### Output and Source Attribution

1. Use stable command ID `lidarr-discover` unless the command-surface owner identifies a conflicting
   convention.
2. JSON and YAML follow the existing `{command,result}` envelope:

   ```json
   {
     "command": "lidarr-discover",
     "result": {
       "seed": {
         "requestedName": "radiohed",
         "resolvedName": "Radiohead",
         "autocorrected": true
       },
       "recommendations": [
         {
           "rank": 1,
           "name": "Thom Yorke",
           "similarity": 0.82,
           "musicBrainzId": "..."
         }
       ],
       "total": 1,
       "source": {
         "provider": "lastfm",
         "method": "artist.getSimilar",
         "attribution": "Recommendations provided by Last.fm",
         "url": "https://www.last.fm/"
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

3. Field names, enum values, omission rules, rank meaning, and similarity scale become public
   compatibility contracts.
4. Human output goes to stderr and includes seed resolution, a ranked table, similarity, optional
   MusicBrainz ID, and an explicit `Source: Last.fm` line with a Last.fm link.
5. Machine output uses stdout exclusively. Logs, warnings, progress, and tables must not corrupt
   JSON/YAML/CSV stdout.
6. CSV needs an explicit stable column list and a summary row even for zero results, followed by
   recommendation rows. This mirrors `lidarr-search` rather than relying on inferred columns.
7. Every output format must retain provider identity. “Last.fm-first” cannot become hidden
   provenance.
8. Do not label `similarity` as percent unless it is deliberately converted and documented. The
   Last.fm contract defines a value between 0 and 1.
9. Add handoff output is a separate object/status (`not-requested`, `planned`, `already-present`,
   `applied`, `failed`, or `uncertain`) and must not overwrite discovery's source or execution
   evidence.
10. Human and machine results must credit and link Last.fm, reflecting the provider's current API
    terms. Exact branding/link presentation should be confirmed against Last.fm's brand guidance
    before release.

### Configuration, Secrets, and Provider Compliance

1. Add one validated Last.fm API-key field with a documented secret template such as
   `{{ LASTFM_API_KEY }}`. Never commit a resolved key.
2. The key is sensitive under the existing generic `apiKey` redaction rule, but CLI failure
   handling must also pass any explicit Last.fm key as a sensitive value.
3. Credentials must live in private provider connection state, not exported discovery results,
   task labels, errors, URLs, cache discriminators, or arbitrary config snapshots.
4. Missing/empty/control-containing keys fail as `configuration` before a request.
5. Last.fm currently requires API registration and an API key even though this read method requires
   no authenticated user session.
6. Last.fm's current API terms require attribution and links, caching consistent with response
   headers, respect for provider rate limits, and a reasonable-usage data cap. #203 must not invent
   a permanent cache policy that ignores response headers.
7. A bounded HTTP-response cache or conditional-request layer needed for terms compliance is
   supporting #203 work. The multi-provider shared cache, provider merge cache, and cross-provider
   invalidation strategy remain #204.
8. Cached provider data, if retained, must be bounded, credential-free, source-attributed, and
   expire or revalidate according to response policy. It must not contain artwork.
9. Commercial distribution/use may require a separate Last.fm agreement. This is a release/legal
   question, not something code can infer.

### Failure and Recovery Rules

1. Validate input and local configuration before network I/O.
2. Schedule one idempotent Last.fm request in the existing `discovery` lane. The default lane policy
   is concurrency 4, operation budget 100, two retries, and a 30-second delay cap.
3. The discovery lane does not run Lidarr's metadata health preflight.
4. Only transient provider/transport failures and explicit rate-limit responses are retryable.
   Validation, configuration, invalid/suspended key, malformed response, and cancellation are not.
5. Honor a valid provider retry delay only within the lane cap; never busy-loop or evade rate
   limits.
6. Existing stable error codes should be reused where semantics are exact:
   - `configuration` for missing local provider setup;
   - `authentication` for invalid or suspended Last.fm key;
   - `validation` for invalid local/provider parameters;
   - `not-found` for a documented unresolved seed, if Last.fm distinguishes it;
   - `rate-limited` for Last.fm error 29/HTTP 429;
   - `timeout` for request timeout;
   - `invalid-response` for malformed or unsafe provider data; and
   - `metadata-provider-unavailable` for Last.fm temporary/offline failures.

7. Never classify a Last.fm outage as `lidarr-unreachable`.
8. Failure output retains the existing machine `{command,error}` shape with lane, attempts,
   failure type, status, retryability, and retry delay. Add a provider identifier only additively.
9. Failure messages and causes must be credential-safe and must not copy raw bodies.
10. A failed Last.fm request performs zero Lidarr work even when an add was requested.
11. A successful Last.fm request followed by unavailable Lidarr returns discovery success plus a
    failed add handoff. The user can retry the exact reviewed add later without repeating or
    misrepresenting discovery.
12. If an add POST may have reached Lidarr but the response is lost, classify it as uncertain,
    stop further additions, and reconcile by MusicBrainz ID before any explicit resume.

## Primary Workflows

### Read-Only Discovery

1. Parse `--artist`, output format, limit, and Last.fm credential source.
2. Validate and normalize the seed and limit before I/O.
3. Resolve a private Last.fm client whose secret cannot be serialized.
4. Submit one idempotent `lidarr-discover` task to the `discovery` lane.
5. Call `artist.getSimilar` with the bounded limit and deliberate autocorrect behavior.
6. Classify any provider error object even when HTTP transport succeeded.
7. Strictly project the resolved seed and bounded recommendations.
8. Remove the seed, deduplicate, preserve provider order, and assign one-based rank.
9. Render attributed text or the stable machine envelope.
10. Exit 0 for a valid empty list and 1 for a classified failure.

### Explicit Add Handoff

1. Run or reuse the visible discovery result.
2. Require an exact candidate choice; reject an unqualified bare `--add`.
3. Require a valid MusicBrainz ID or run typed Lidarr artist lookup to obtain an unambiguous exact
   candidate.
4. Resolve the canonical Lidarr origin and fresh current artist state.
5. Return `already-present` without mutation when the MusicBrainz ID exists locally.
6. Resolve and display every root/profile/monitor/search option needed for an add.
7. Produce a reviewed single-target plan/handoff bound to the Lidarr origin and exact foreign ID.
8. Require the existing interactive approval or explicit `--yes` gate for a real write.
9. Immediately recheck identity and relevant resources before POST.
10. Submit the non-idempotent add once, read back by identity, and record `applied`, `failed`, or
    `uncertain` without automatically retrying an uncertain dispatch.

## Recovery Workflows

### Last.fm Is Unavailable or Rate-Limited

1. Classify the failure and retain `source.provider: "lastfm"` in machine diagnostics.
2. Apply only bounded scheduler retry policy and provider-supplied delays.
3. If no valid terms-compliant cache is available, fail visibly; do not call Lidarr search as a
   hidden substitute.
4. If a valid cache policy is implemented, visibly mark cached/degraded output and preserve source
   age. Silent stale substitution is inconsistent with current repository resilience patterns.
5. Do not fall through to ListenBrainz or MusicBrainz in #203.

### Last.fm Succeeds but Lidarr Handoff Fails

1. Preserve and render the successful recommendation set.
2. Report the add handoff as a separate failed state with the Lidarr error code and lane.
3. Perform no alternate-candidate or bulk add.
4. Let the operator fix Lidarr/configuration and explicitly retry the reviewed exact candidate.

### Ambiguous or Missing Candidate Identity

1. Keep the candidate in read-only discovery output.
2. Mark add eligibility false or omit an add token.
3. Attempt typed Lidarr lookup only after explicit add intent.
4. On multiple lookup results, show bounded choices and require exact selection.
5. On zero results, fail the add handoff without changing discovery success.

### Uncertain Add Dispatch

1. Stop admitting subsequent add work.
2. Query fresh Lidarr state by the selected MusicBrainz ID.
3. If present with the reviewed policy, classify as applied.
4. If absent and dispatch is proven not to have occurred, an explicit retry may proceed.
5. If state remains inconclusive, retain `uncertain`; never automatic-replay the POST.

## Domain Model and State Transitions

### Domain Objects

- **Discovery seed**: normalized requested artist name plus optional resolved Last.fm name and
  correction evidence.
- **Discovery recommendation**: bounded Last.fm projection with rank, artist name, similarity,
  optional MusicBrainz ID, and optional Last.fm catalogue URL.
- **Source attribution**: provider ID, method, required credit text, and provider link. It describes
  provenance, not availability or endorsement.
- **Discovery result**: seed, ordered recommendations, counts, source, optional cache/degradation
  evidence, and discovery-lane execution metadata.
- **Candidate identity**: valid MusicBrainz ID when present; a provider/name fallback is sufficient
  for deduplication and display but not durable Lidarr mutation.
- **Add eligibility**: whether one recommendation has enough exact identity to enter fresh Lidarr
  resolution. Eligibility is not consent.
- **Add handoff**: explicit operator intent binding one exact recommendation to one canonical
  Lidarr origin and fully resolved add policy.
- **Add outcome**: independent terminal/recoverable state for the optional Lidarr step.

### Discovery State Machine

```text
requested
  -> validating
  -> scheduled(discovery)
  -> provider-requested(lastfm)
  -> projected
  -> succeeded(empty | recommendations)

validating/provider-requested/projected
  -> failed(classified)

scheduled/provider-requested
  -> cancelled
```

`succeeded` has no Lidarr side effect and is terminal for the default workflow.

### Optional Add State Machine

```text
not-requested
  -> candidate-selected
  -> lidarr-resolving
  -> already-present
  -> review-ready
  -> approved
  -> dispatched
  -> applied

candidate-selected/lidarr-resolving/review-ready
  -> blocked(validation | ambiguity | configuration | drift)

approved/dispatched
  -> failed

dispatched
  -> uncertain
  -> reconciled(applied | retry-safe | still-uncertain)
```

Discovery success does not transition backward when the optional add path is blocked or fails.

## Existing Codebase Integration

| Existing area                                                                       | Reusable contract                                                                                                          | #203 implication                                                                                                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/commands/lidarr.ts`                                       | Registers sibling command factories, central format resolution, credential-safe failure rendering, and text/machine parity | Register a focused discovery command factory and reuse the existing reporter/execution summary                                                                |
| `packages/rfmedia-cli/src/commands/lidarr-search.ts`                                | Validates before action import, explicit CSV columns, `{command,result}`, tables on stderr, machine output on stdout       | Closest command/presenter pattern; do not conflate Lidarr search's provider or metadata lane with Last.fm discovery                                           |
| `packages/rfmedia-cli/src/actions/lidarr/search.ts`                                 | Scheduler-owned idempotent work, immutable results, strict cache revalidation, execution metadata                          | Reuse lifecycle shape, but discovery resolves a Last.fm client and uses the `discovery` lane without Lidarr preflight                                         |
| `packages/rfmedia-cli/src/lib/lidarr/search.ts`                                     | Safe term normalization, first-win dedupe, rank-before-page, bounded collections                                           | Reuse or extract validation concepts without pretending Last.fm candidates are Lidarr search candidates                                                       |
| `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`                                  | Shipped `discovery` lane: concurrency 4, budget 100, two retries, 30-second delay cap                                      | No new scheduler enum or generic executor is needed                                                                                                           |
| `packages/rfmedia-cli/src/lib/lidarr/tiers.ts`                                      | Discovery is independent of the Lidarr metadata server and has no health gate                                              | This is the architectural authority for #203                                                                                                                  |
| `packages/rfmedia-cli/src/lib/lidarr/errors.ts`                                     | Stable classification, status, retryability, retry delay, credential-safe messages                                         | Map provider failures into exact existing semantics; never use `lidarr-unreachable` for Last.fm                                                               |
| `packages/rfmedia-cli/src/types/config.ts` and `src/lib/config.ts`                  | Typed validated config, template resolution, secret redaction, scheduler settings                                          | Add and validate one Last.fm credential/config section; unknown nested keys are currently dropped in several Lidarr config paths, so strictness is a decision |
| `packages/rfmedia-cli/src/lib/lidarr/client.ts`                                     | Private generated Lidarr facade; currently supports search/lookup but not artist create                                    | Ordinary discovery must not extend or call it; add handoff requires a new narrow artist-add capability                                                        |
| `packages/rfmedia-cli/src/lib/lidarr/generated/*`                                   | Private generated `POST /api/v1/artist` and broad `ArtistResource`/`AddArtistOptions` wire DTOs                            | Generated types remain private; they prove add needs explicit root/profile/monitor policy, not name-only POST                                                 |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` and plan operation definitions | Sealed, origin-bound, checksummed, allowlisted mutation plans with drift checks and recovery                               | Artist-add is not currently allowlisted; extending this boundary is material work, not a command flag                                                         |
| `packages/rfmedia-cli/src/types/lidarr.ts`                                          | Public projections are narrow, immutable, and generated-independent                                                        | New discovery domain types belong in the issue-requested `src/types/discovery.ts`, not generated DTO exports                                                  |
| Shell completion templates and `templates.spec.ts`                                  | Bash, Zsh, and Fish command/flag parity is required for command-surface changes                                            | Add `discover`, `--artist`, and every shipped discovery/add flag to all three                                                                                 |
| `ROADMAP.md`                                                                        | #203 begins Layer 2; #205, #206, and #219 complete the safe-add path; #204 is optional/later                               | Do not claim the complete discovery safety sprint is delivered by #203 alone                                                                                  |

### Relevant Internal and External Documentation

- [ROADMAP.md](../../../ROADMAP.md): current sequencing and Layer 2/optional #204 boundary.
- [Lidarr Search and Lookup](../../../packages/rfmedia-cli/docs/features/lidarr-search-lookup.md):
  shipped query, output, cache, and failure conventions.
- [Lidarr Execution Lanes](../../../packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md):
  discovery-lane policy and machine execution metadata.
- [Lidarr Mutation Plan/Apply](../../../packages/rfmedia-cli/docs/features/lidarr-plan-apply.md):
  current mutation review, drift, approval, and uncertainty rules.
- [Lidarr integration research](../../../research/rfmedia-lidarr-integration/report.md):
  layered architecture, Last.fm-first recommendation, and read-only-by-default rationale.
- [Last.fm `artist.getSimilar`](https://www.last.fm/api/show/artist.getSimilar): official method,
  input, similarity, and error documentation.
- [Last.fm API terms](https://www.last.fm/api/tos): attribution, link, caching, usage, and licensing
  obligations that must be reviewed for release.

## Testable Success Criteria

1. `rfmedia lidarr discover --artist "Radiohead"` performs one scheduled Last.fm
   `artist.getSimilar` operation in lane `discovery` and performs zero Lidarr requests.
2. Omitting `--artist`, passing empty/unsafe/oversized text, or an invalid limit fails before any
   client or scheduler I/O.
3. The default request is bounded to the accepted shallow result count; the documented maximum
   cannot be exceeded.
4. Last.fm autocorrection, when enabled and returned, preserves both requested and resolved seed
   names in every structured format.
5. Valid recommendations preserve Last.fm order, remove the seed, deduplicate first-win, and
   receive contiguous one-based ranks.
6. Every recommendation has a safe non-empty name and similarity in `[0,1]`; invalid required data
   fails atomically as `invalid-response`.
7. Empty or absent MusicBrainz IDs are omitted without failing read-only discovery; malformed
   non-empty IDs fail validation of the provider response.
8. No Last.fm artwork/image data crosses the domain boundary.
9. Text output identifies and links Last.fm. JSON, YAML, and CSV all carry stable Last.fm source
   attribution and discovery execution metadata.
10. Text tables/logs use stderr; JSON/YAML/CSV use stdout only and remain parseable.
11. CSV emits the documented summary row and fixed columns even when there are zero recommendations.
12. A valid empty result exits 0; invalid key, rate limit, provider offline, timeout, invalid
    response, configuration error, and cancellation are separately tested failures.
13. Last.fm error objects returned with HTTP 200 do not become empty successes.
14. Error output never contains the Last.fm key, query-string credential, raw response body, or a
    credential-bearing URL.
15. Retry tests prove only idempotent transient/rate-limit failures retry, provider delays are
    bounded, and cancellation does not retry.
16. Ordinary discovery succeeds when Lidarr configuration is absent and when mocked Lidarr is
    unavailable.
17. No #204-only `--source`, alternate provider, provider merge, weighted aggregation, or Plex seed
    appears in #203's command surface.
18. No #205-only multi-hop, `--deep`, diversity, threshold, quarantine, loop, or automatic bulk-add
    behavior appears in #203.
19. A bare `--add` with multiple/no explicit candidates fails before Lidarr mutation.
20. Add intent for a candidate without a valid MusicBrainz ID cannot directly POST to Lidarr.
21. Add intent resolves fresh typed Lidarr lookup; zero/ambiguous results make no mutation.
22. An already-present MusicBrainz ID produces `already-present` and no POST.
23. A real add cannot proceed until root, quality profile, metadata profile, monitoring, and search
    policy are all explicit and reviewable.
24. Machine/non-interactive real add requires `--yes`; default/preview execution makes no POST.
25. Add dispatch is never automatically retried after an uncertain response, and reconciliation
    uses the exact MusicBrainz ID.
26. Discovery success remains visible and successful when its separate add handoff fails.
27. Config tests cover template resolution, missing/empty keys, wrong types, redaction, and the
    chosen unknown-key policy.
28. Provider tests use injected fetch and fixtures; no unit/contract test requires live Last.fm,
    Lidarr, MusicBrainz, ListenBrainz, or Plex.
29. Bash, Zsh, and Fish templates expose identical `discover` commands/options and parity tests
    pass.
30. Existing Lidarr search, lookup, baseline reads, plan/apply, output, config, error, scheduler,
    architecture, and generated-client boundary tests remain green.

## Open Questions

1. Is #203's “optional `--add` integration path” satisfied by a reviewed handoff/plan, or must this
   issue also add a real `POST /api/v1/artist` operation? The latter intentionally pulls in a subset
   of #206.
2. What exact candidate selector accompanies `--add`? A bare boolean is ambiguous. Recommend an
   exact MusicBrainz ID or a separate `lidarr add` command consuming that ID.
3. Where should Last.fm config live: `lidarr.discovery.lastfm.apiKey`, top-level
   `discovery.lastfm.apiKey`, or another provider-specific section? Top-level discovery config is
   architecturally cleaner because read-only discovery works without Lidarr, while the command
   remains under `lidarr` for user navigation.
4. Should a credential CLI flag exist? It is consistent with Lidarr overrides but increases process
   list/history exposure. A config/template-only key may be safer.
5. Should Last.fm autocorrection default on? If yes, the exact JSON evidence for “corrected” must be
   confirmed with recorded real/fixture responses.
6. Are default 15 and maximum 100 accepted? Last.fm documents `limit` but not a maximum on the
   method page.
7. Does the release's intended use comply with Last.fm's non-commercial terms, attribution/link
   rules, brand guidance, and 100 MB reasonable-usage cap, or is provider approval required?
8. What cache behavior do actual Last.fm response headers require? This should be verified
   empirically before choosing TTL, stale fallback, or persistence.
9. Should #203 offer stale provider results at all? If so, explicit consent and visible source age
   should mirror current Lidarr search behavior; silent fallback is not acceptable.
10. Is `metadata-provider-unavailable` acceptable for a direct Last.fm failure, or should the error
    taxonomy gain a provider-neutral `discovery-provider-unavailable` code? Changing the union
    affects scheduler and machine-output compatibility.
11. When Last.fm omits an MBID, should explicit add intent invoke Lidarr name lookup, or should the
    candidate simply be marked non-addable in #203?
12. Which root folder, quality profile, metadata profile, monitoring, and search settings are
    required for the minimum add path? No safe current defaults exist.
13. Should the add handoff extend `rfmedia.lidarr-plan.v2` with `artist-add`, introduce a new
    version, or wait for #206's dedicated `lidarr add` design? Unknown operation kinds currently
    fail closed.
14. Does the optional add path support exactly one candidate in #203? Recommend yes; multi-add
    selection, quarantine, and budgets belong to #205/#219.
15. Should recommendations report local-library presence? Doing so makes ordinary discovery depend
    on Lidarr and conflicts with the issue's independent read-only value. Recommend presence only
    during explicit add resolution.
16. Should a Last.fm catalogue URL be required per recommendation for terms-compliant linking, or
    is one command-level attribution link sufficient? Confirm with provider guidance.
17. What maximum response bytes, candidate count before limiting, label length, and timeout should
    the provider boundary enforce? They should be explicit before implementation.
18. Does the provider return meaningful `Retry-After` information for its application-level error
    29, or must rfmedia use only bounded scheduler backoff?
