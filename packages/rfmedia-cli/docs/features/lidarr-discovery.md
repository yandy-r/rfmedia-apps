# Lidarr Similar-Artist Discovery

`rfmedia lidarr discover` retrieves similar artists from Last.fm. The default path is read-only and
independent of Lidarr: it makes one `artist.getSimilar` request, schedules it in the `discovery`
lane, and performs zero Lidarr calls.

Discovery is intentionally separate from mutation. Explicit `--add <ranks>` approval can resolve
up to 25 MusicBrainz-identified recommendations against fresh Lidarr state and write at most one
sealed multi-entry `artist-add` plan. Only a later, separately approved `rfmedia lidarr apply` can
create an artist.

## Configure Last.fm

Create a Last.fm application API key, export it through your normal secret-injection mechanism, and
add this section to `.rfmedia.yaml`:

```yaml
discovery:
  lastfm:
    apiKey: "{{ LASTFM_API_KEY }}"
    timeoutMs: 15000
```

There is no `--lastfm-api-key` option, provider selector, or configurable provider URL. The key is
sent only to the fixed HTTPS Last.fm API origin and is not persisted in output, plans, history, or
cache data.

Configuration template expansion is repository-wide and eager. If
`apiKey: "{{ LASTFM_API_KEY }}"` is present, `LASTFM_API_KEY` must exist whenever that configuration
file is loaded, including for commands unrelated to discovery. This is not an invocation-lazy
placeholder. Omit the entire `discovery` section from configurations that should not require the
environment variable.

For example:

```bash
export LASTFM_API_KEY="<application-api-key>"
rfmedia lidarr discover --artist "Radiohead"
```

`timeoutMs` is optional, defaults to 15,000 milliseconds, and accepts 1–300,000. The API key is an
application credential; discovery does not use a Last.fm username, user session, shared secret, or
password.

## Discover Similar Artists

The exact command surface is:

```text
rfmedia lidarr discover --artist <name>
  [--limit <n>]
  [--no-autocorrect]
  [--min-similarity <score>]
  [--max-per-seed <count>]
  [--deep | --no-cascade]
  [--diversity-boost <weight>]
  [--popularity-dampening <weight>]
  [--max-add <count>]

Optional add-plan handoff:
  --add <ranks>
  --root-folder <reference>
  --quality-profile <reference>
  --metadata-profile <reference>
  --monitored
  --unmonitor-types <types>
  --plan-file <path>
  --lidarr-url <url>
  --lidarr-api-key <key>
```

Examples:

```bash
# Default: up to 15 results with Last.fm autocorrection enabled
rfmedia lidarr discover --artist "Radiohead"

# Request a smaller result set and preserve the entered seed spelling
rfmedia lidarr discover --artist "Radiohed" --limit 10 --no-autocorrect

# Traverse exactly two breadth-first levels with explicit policy weights
rfmedia lidarr discover \
  --artist "Radiohead" \
  --deep \
  --min-similarity 0.35 \
  --max-per-seed 8 \
  --diversity-boost 0.2 \
  --popularity-dampening 0.1

# Machine-readable output; global output flags appear before lidarr
rfmedia --output json lidarr discover --artist "Radiohead"
rfmedia --output yaml lidarr discover --artist "Radiohead"
rfmedia --output csv lidarr discover --artist "Radiohead"
```

| Option                            | Default | Accepted value and interaction                                                |
| --------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `--artist <name>`                 | —       | Required; normalized; 1–256 code points and at most 1,024 UTF-8 bytes         |
| `--limit <n>`                     | `15`    | Per-request Last.fm result limit; integer 1–100                               |
| `--no-autocorrect`                | off     | Disables Last.fm autocorrection, which is enabled by default                  |
| `--min-similarity <score>`        | `0`     | Inclusive raw-similarity threshold; finite decimal 0–1                        |
| `--max-per-seed <count>`          | `10`    | Admitted candidates per seed; integer 1–100                                   |
| `--deep`                          | off     | Enables fixed depth-two breadth-first traversal                               |
| `--no-cascade`                    | off     | Explicitly forces one hop; conflicts with `--deep`                            |
| `--diversity-boost <weight>`      | `0`     | Graph-novelty ranking weight; finite decimal 0–1                              |
| `--popularity-dampening <weight>` | `0`     | Graph-exposure ranking weight; finite decimal 0–1                             |
| `--max-add <count>`               | `1`     | Approval ceiling; integer 1–25; allowed without `--add` for preview policy    |
| `--add <ranks>`                   | —       | Unique comma-separated visible ranks 1–100; count must not exceed `--max-add` |
| `--root-folder <reference>`       | —       | Existing Lidarr root folder; required with `--add`                            |
| `--quality-profile <reference>`   | —       | Existing Lidarr quality profile; required with `--add`                        |
| `--metadata-profile <reference>`  | safe    | Existing profile; otherwise resolve an albums-only profile structurally       |
| `--monitored`                     | off     | Positive-only override that adds the artist as monitored                      |
| `--unmonitor-types <types>`       | —       | Canonical album types to unmonitor after the artist is created                |
| `--plan-file <path>`              | —       | Destination for the one sealed plan; required with `--add`                    |
| `--lidarr-url <url>`              | config  | Optional Lidarr connection override used only during add planning             |
| `--lidarr-api-key <key>`          | config  | Optional Lidarr key override used only during add planning                    |

Without `--deep`, both the normal cascade default and explicit `--no-cascade` remain one hop.
`--deep --no-cascade` is rejected. Thresholding happens before the per-seed cap, so below-threshold
rows do not consume that cap. Ranking weights never change threshold admission because the
threshold always uses raw Last.fm similarity.

`--root-folder`, `--quality-profile`, and `--plan-file` are required with `--add`.
`--metadata-profile`, `--monitored`, `--unmonitor-types`, and every add-only resource or connection
option are rejected without `--add`. Supplying `--max-add` alone is valid and reports the resolved
preview policy, but performs no Lidarr resolution or filesystem write. The command does not accept
`--yes`, `--dry-run`, `--allow-stale`, provider-selection flags, or a Last.fm credential flag.
Machine formats never prompt.

## Traversal Bounds and Loop Prevention

The default makes exactly one provider request and returns depth-one candidates. `--deep` uses
deterministic breadth-first waves: it completes the initial seed request, admits and pre-registers
the next seeds in provider order, then requests those seeds to produce depth-two candidates. It
never traverses beyond depth two, and arbitrary user-selected depth is not supported.

One invocation enforces all of these ceilings before scheduling or admitting more work:

- at most 100 provider results per request (`--limit`);
- at most 100 admitted candidates per seed (`--max-per-seed`, default 10);
- at most 25 provider requests;
- at most 2,500 candidate exposures across all bounded provider responses;
- at most 25 visited seed identities, including the initial seed;
- at most 100 visible candidates; and
- at most 25 explicitly approved ranks (`--max-add`, default 1).

The request and visited limits are separate public contracts even though both are currently 25.
The action owns these invocation-wide limits because the scheduler's batch budget resets between
breadth-first waves. Caller cancellation prevents new wave admission and reaches every scheduled
Last.fm request.

Loop identity is MusicBrainz-first: `mbid\0<canonical-lowercase-mbid>` when a candidate has an
MBID, otherwise `lastfm-name\0<NFC-case-folded-name>`. The initial seed is registered before the
first request, and every future seed is registered before scheduling. Consequently, two parents
cannot enqueue the same identity concurrently. A duplicate or back-edge adds exposure evidence to
the first visible identity when applicable; it does not create another row or request.

## Understand the Results

Every success carries both the requested seed and the name resolved by Last.fm:

- `seed.requestedName` is the normalized value supplied to `--artist`.
- `seed.resolvedName` is the provider-resolved seed used for the recommendations.
- `seed.autocorrected` is true only when Last.fm reports correction evidence.

Each candidate retains its original seed, parent, depth, provider rank, first-seen sequence,
first path, discovery time, and exposure count. Final visible ordering is deterministic:
`adjustedScore` descending, raw similarity descending, depth ascending, first-seen sequence
ascending, then normalized name ascending. Visible `rank` values are reassigned contiguously from

1. A rank belongs only to this fresh invocation; it is neither a durable identity nor approval in
   a later invocation.

Each recommendation contains:

- `name`: the validated provider artist name;
- `similarity` and `rawSimilarity`: the same immutable finite Last.fm match value from 0 through 1;
- `adjustedScore`: the bounded policy ranking score;
- `musicBrainzId`: an optional canonical lowercase MusicBrainz artist UUID;
- `sourceUrl`: the validated Last.fm artist catalogue URL;
- `addEligibility`: `exact-id` when an MBID is present, otherwise `requires-resolution`;
- `status` and `reason`: the invocation-scoped lifecycle decision;
- `exposureCount` and optional `popularityEvidence: "graph-exposure"`; and
- `provenance`: the first path and provider position that exposed the candidate.

Similarity is not a confidence score, probability, identity match, or indication that adding the
artist is safe. MBID-less recommendations remain valid discovery output but cannot be selected for
an add-plan handoff.

Raw similarity is never overwritten. The optional score adjustments use only graph paths observed
during this invocation:

```text
novelty = 1 / exposureCount
exposure = (exposureCount - 1) / exposureCount
adjustedScore = clamp(
  similarity
  + diversityBoost * novelty * (1 - similarity)
  - popularityDampening * exposure * similarity,
  0,
  1
)
```

Here “popularity” means graph exposure only. Last.fm listener counts, play counts, popularity
scores, tags, and other provider enrichment are not requested or inferred. When dampening is
non-zero, output discloses `popularityEvidence: "graph-exposure"`.

Candidate lifecycle is invocation-only:

- `filtered`: excluded by threshold or a hard cap and counted with a stable reason;
- `visited`: a duplicate identity or back-edge retained only as path/exposure evidence;
- `quarantined`: visible but unselected, or missing a mutation-safe MBID; and
- `approved`: explicitly selected by current visible rank and eligible for planning.

There is no hidden queue, database record, expiry, or cross-invocation rediscovery suppression.
Unselected candidates disappear when the invocation ends. Durable intent starts only if approved
candidates are written to a sealed plan; durable apply history starts later during apply.

Every successful result, including zero recommendations, carries:

- `source.provider: "lastfm"`;
- `source.method: "artist.getSimilar"`;
- `source.attribution: "Recommendations provided by Last.fm"`;
- the Last.fm site and candidate catalogue links;
- a fetch timestamp; and
- scheduler lane, attempt, and outcome metadata.

The implementation does not retain images, artwork, biographies, tags, streamability, arbitrary
provider fields, or raw response bodies.

## Output Formats

Text is the default. Human tables, attribution, handoff state, and the execution summary are written
to stderr. Similarity is displayed to four decimal places, and a missing MBID is shown as `-`.

JSON and YAML write one standard envelope to stdout. This abbreviated example illustrates the
schema; live recommendation values vary:

```json
{
  "command": "lidarr-discover",
  "result": {
    "seed": {
      "requestedName": "Radiohead",
      "resolvedName": "Radiohead",
      "autocorrected": false
    },
    "request": {
      "limit": 15,
      "autocorrect": true
    },
    "policy": {
      "minSimilarity": 0,
      "maxPerSeed": 10,
      "deep": false,
      "cascade": true,
      "maxDepth": 1,
      "diversityBoost": 0,
      "popularityDampening": 0,
      "maxAdd": 1
    },
    "traversal": {
      "seedsRequested": 1,
      "requestsMade": 1,
      "maximumDepthReached": 1,
      "visited": 1,
      "visible": 1,
      "filtered": 0,
      "duplicatePaths": 0
    },
    "recommendations": [
      {
        "rank": 1,
        "name": "Thom Yorke",
        "similarity": 1,
        "musicBrainzId": "8ed2e0b3-aa75-4dc3-8c12-056e92fe154c",
        "sourceUrl": "https://www.last.fm/music/Thom+Yorke",
        "addEligibility": "exact-id"
      }
    ],
    "returned": 1,
    "source": {
      "provider": "lastfm",
      "method": "artist.getSimilar",
      "attribution": "Recommendations provided by Last.fm",
      "url": "https://www.last.fm/",
      "fetchedAt": "2026-07-25T12:00:00.000Z"
    },
    "execution": {
      "taskId": "lidarr-discover",
      "operation": "lidarr discover",
      "lane": "discovery",
      "outcome": "succeeded",
      "attempts": 1
    },
    "handoff": {
      "status": "not-requested",
      "approvals": []
    }
  }
}
```

Optional fields such as `musicBrainzId` are omitted instead of emitted as `null`.

CSV has a fixed schema. It always emits one `summary` row containing seed, request, resolved policy,
hard bounds, traversal, source, execution, and handoff metadata, followed by one `recommendation`
row per result. A successful zero-result response therefore still emits its attributed summary
row.

If discovery succeeds but a requested add handoff fails, JSON and YAML still emit exactly one
complete discovery document with `handoff.status: "failed"`. CSV records the same sanitized failure
on the summary row. Recommendations are not discarded and no second machine error document is
written; the process exit code is set to 1 after output.

## Create One Multi-Entry Add Plan

Select one or more current visible ranks and provide the required policy resources:

```bash
rfmedia lidarr discover \
  --artist "Radiohead" \
  --deep \
  --max-add 3 \
  --add 1,4,7 \
  --root-folder "/music" \
  --quality-profile "Lossless" \
  --unmonitor-types singles,eps \
  --plan-file ./radiohead-similar-artist.json
```

Ranks are normalized into ascending visible-rank order. The complete selection is validated
atomically before planning: ranks must be unique and visible, the selection count must not exceed
the resolved `--max-add`, and every candidate must have a canonical MBID. Any invalid or
ineligible rank fails the handoff and writes no partial plan.

Add planning then performs fresh Lidarr reads to:

1. resolve the root folder and quality profile once without ambiguity;
2. resolve an explicit metadata profile, or safely select an omitted profile from structural
   server evidence;
3. resolve every selected candidate by exact MBID;
4. classify every selected MBID against the current library;
5. omit already-present candidates from mutation entries while retaining their per-rank outcome;
   and
6. write one origin-bound, checksum-protected `rfmedia.lidarr-plan.v2` artifact containing the
   remaining addable entries in visible-rank order.

When `--metadata-profile` is omitted, the selected root folder's default is used only when its
allowed primary types are exactly `Album` and it allows no secondary type. Otherwise planning uses
the sole metadata profile with that same structural albums-only policy. Zero or multiple
structurally eligible profiles fail closed and require explicit `--metadata-profile`; profile names
are not used as safety evidence.

The plan's `maxBatch` equals its addable entry count and cannot exceed the resolved `--max-add` or
the hard maximum of 25. Each entry retains its own Last.fm provenance. If every selected MBID is
already installed, the handoff returns `already-present` and writes no plan. A mixed selection
writes one plan for only the addable entries. Missing or ambiguous identity/resources fail the
whole handoff without changing Lidarr or leaving a plan file.

Omitted policy is safe: the artist is unmonitored and no post-add album normalization is requested.
`--monitored` is the only monitoring override; there is no negative flag because unmonitored is
already the default. New-item monitoring and missing-album search remain disabled in both cases:

```text
monitored = false
monitorNewItems = none
searchForMissingAlbums = false
postAddUnmonitorSelectors = []
```

`--unmonitor-types` accepts the same closed album-type vocabulary as album monitoring:
`albums`, `eps`, `singles`, `broadcasts`, `others`, `compilations`, `live`, `remixes`,
`soundtracks`, `demos`, and `mixtapes`. Tokens are trimmed and lowercased, singular aliases are
converted to their canonical plural forms, duplicates are rejected after canonicalization, and the
sorted selectors are sealed in the plan. They use OR matching at apply and do not enable
`monitorNewItems` or `searchForMissingAlbums`.

The plan also records expected absence, the selected MBID, resolved resource IDs and labels,
Last.fm provenance, canonical Lidarr origin, plan identity, checksum, and idempotency material. It
does not store either API key.

`discover --add` only writes reviewed intent. It never prompts, accepts `--yes`, or sends an
artist-create request. Explicit ranks approve candidates for planning, not mutation. Review and
check the artifact before separately approving apply:

```bash
# Revalidate the artifact, expected absence, resources, origin, and live state
rfmedia lidarr apply ./radiohead-similar-artist.json --dry-run

# Apply interactively
rfmedia lidarr apply ./radiohead-similar-artist.json

# Separate non-interactive mutation approval
rfmedia lidarr apply ./radiohead-similar-artist.json --yes
```

## Apply Safety and Recovery

Artist creation is non-idempotent and non-deferable. Apply processes the sealed entries in order
and uses this fail-closed sequence for each admitted entry:

1. Revalidate the exact MBID and every sealed resource against fresh Lidarr state.
2. Treat desired existing state as safely satisfied, absence as ready, and conflicting existing
   state or policy as drift.
3. While holding the exclusive apply claim, persist `possibly-dispatched` evidence before the one
   generated artist-create request.
4. Dispatch once with the sealed monitoring policy while keeping `monitorNewItems: "none"` and
   `searchForMissingAlbums: false`.
5. Read back by exact MBID to prove the desired artist state.
6. If selectors were sealed, persist that creation is verified but normalization is pending, read
   only that artist's albums, unmonitor currently monitored matches in bounded batches, and re-read
   to verify that no match remains monitored.

Apply never blindly retries artist creation and never creates a deferred intent for it. A lost
response can still become `succeeded` when exact-MBID read-back proves the reviewed artist and
policy. An absent, conflicting, cancelled, or unreadable post-dispatch state becomes `uncertain`.
Apply immediately stops admitting later entries and records them as `not-attempted`.

Normalization is a separate resumable stage. Creation verified with normalization pending, or
normalization dispatched but not yet verified, is reported as an incomplete `partial` apply rather
than terminal success. An empty artist-scoped album read is not treated as successful
normalization: the bounded invocation stops, records an explicit incomplete stage, and requires
`--resume`. Resume uses the durable Lidarr artist ID, rereads current albums, and updates only
remaining monitored matches.

Use the pinned resume command printed by apply:

```bash
rfmedia lidarr apply ./radiohead-similar-artist.json \
  --resume \
  --expected-plan-id <plan-id> \
  --expected-plan-checksum <checksum>
```

Add `--yes` when the resume is non-interactive. Resume uses matching durable
`possibly-dispatched` evidence to reconcile by MBID; it does not resend the create request. When
creation was already verified, resume continues album normalization for that known artist and
never authorizes a second artist POST. For a multi-entry plan, resume reconciles every entry with
possible-dispatch or incomplete-normalization evidence before admitting fresh entries. If any
reconciliation or normalization remains uncertain, later pending entries remain `not-attempted`.

## Provider Failures, Retry, and Cache

The shared scheduler is the only retry owner. It may retry an idempotent discovery request only for
classified transient provider availability, timeout, or rate-limit failures and only within the
configured `discovery` lane allowance. Authentication, authorization, configuration, validation,
invalid-response, and caller-abort failures do not retry.

There is no Last.fm cache, `--allow-stale`, or retained provider response. Every successful
invocation is fresh. The ordinary command performs no Lidarr preflight and does not affect Lidarr
or metadata-service circuit breakers.

## Last.fm Attribution and Terms

The Last.fm API introduction, `artist.getSimilar` method, and API Terms of Service were checked on
2026-07-25. Last.fm requires an API key for the method, describes the `match` value as similarity
from 0 to 1, and requires Last.fm credit and links when its data is used. Its published terms limit
ordinary use to non-commercial purposes unless a separate agreement applies and can change over
time.

Every output format therefore retains the required Last.fm attribution and links. Operators are
responsible for rechecking the [Last.fm API documentation](https://www.last.fm/api/intro),
[`artist.getSimilar` method](https://www.last.fm/api/show/artist.getSimilar), and
[API Terms of Service](https://www.last.fm/api/tos) for their use and before a release.

## Intentionally Unshipped Scope

Issue #205 deliberately does not ship these adjacent roadmap items:

- [#204](https://github.com/yandy-r/rfmedia-apps/issues/204): provider federation, enrichment,
  listener/play-count popularity data, selection/fallback, merging, or Last.fm response caching;
- durable cross-invocation quarantine, expiry, rediscovery suppression, or multi-operator approval;
- [#219](https://github.com/yandy-r/rfmedia-apps/issues/219): downstream cascade impact and
  indexer, search, acquisition, or download budgets.

There is also no Plex seed, MusicBrainz network lookup, configurable Last.fm endpoint, paging,
stale result, or automatic post-add acquisition.

## See Also

- [Lidarr Execution Lanes](lidarr-execution-lanes.md)
- [Lidarr Mutation Plan/Apply](lidarr-plan-apply.md)
- [Lidarr Generated Client](lidarr-generated-client.md)
- [Lidarr Search and Lookup](lidarr-search-lookup.md)
