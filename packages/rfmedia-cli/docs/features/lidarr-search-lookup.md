# Lidarr Search and Lookup

## Overview

The Lidarr command suite can search the configured Lidarr instance for mixed artist and album
candidates or run a type-specific lookup. These commands are read-only: they do not add artists or
albums, change monitoring, refresh metadata, download files, or enter the plan/apply workflow.

All three paths use Lidarr as the only live provider:

```bash
rfmedia lidarr search "Björk"
rfmedia lidarr lookup artist "Björk"
rfmedia lidarr lookup album "Debut"
```

| Command                               | Command ID             | Result kinds       |
| ------------------------------------- | ---------------------- | ------------------ |
| `rfmedia lidarr search <term>`        | `lidarr-search`        | Artists and albums |
| `rfmedia lidarr lookup artist <term>` | `lidarr-lookup-artist` | Artists only       |
| `rfmedia lidarr lookup album <term>`  | `lidarr-lookup-album`  | Albums only        |

## Options

Each command accepts the same options:

| Option                   | Default | Description                                                      |
| ------------------------ | ------- | ---------------------------------------------------------------- |
| `--limit <n>`            | `50`    | Return 1–200 candidates from the locally ranked result           |
| `--offset <n>`           | `0`     | Skip a non-negative, safe-integer number of ranked candidates    |
| `--allow-stale`          | Off     | Permit exact-query cache fallback after an eligible live failure |
| `--lidarr-url <url>`     | Config  | Override the configured Lidarr base URL                          |
| `--lidarr-api-key <key>` | Config  | Override the configured Lidarr API key                           |

Global `--json` and `--output <format>` options apply to these commands. Put a global option before
`lidarr`, for example:

```bash
rfmedia --output json lidarr search "Björk" --limit 10
rfmedia --output yaml lidarr lookup artist "Massive Attack"
rfmedia --output csv lidarr lookup album "Mezzanine" --offset 5
```

## Search Terms and Exact IDs

Input is validated before the action, client, database, or cache is initialized. A term is
outer-trimmed and NFC-normalized while its case and internal whitespace are preserved. It must:

- contain 1–256 Unicode code points;
- occupy at most 1,024 UTF-8 bytes; and
- contain no C0, C1, or bidirectional control characters.

The prefixes `lidarr:`, `lidarrid:`, and `mbid:` select an exact MusicBrainz identifier. Prefix
matching is case-insensitive, but the remainder must be exactly one UUID. A valid exact term is
canonicalized to `lidarr:<lowercase-uuid>` in requests, cache identity, and output.

```bash
rfmedia lidarr lookup artist "mbid:87e748f1-300e-46e4-9524-a4a65d68ae24"
```

Malformed exact identifiers, unsafe terms, and invalid paging values fail locally without Lidarr or
cache I/O.

## Candidate Model

Search results expose stable domain projections rather than generated OpenAPI models. Every
candidate includes:

| Field       | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `kind`      | Explicit `artist` or `album` discriminator               |
| `foreignId` | Durable MusicBrainz artist or release-group UUID         |
| `name`      | Artist name or album title                               |
| `rank`      | One-based position in the complete deduplicated result   |
| `lidarrId`  | Optional positive local Lidarr ID when already installed |

Artist candidates may also include `disambiguation` and `artistType`. Album candidates may include
`artistName`, `artistForeignId`, `albumType`, and `releaseDate`. Profiles, paths, tags, images,
links, tracks, releases, and generated response fields do not cross the client boundary.

The combined search accepts only entries with exactly one explicit artist or album payload. Typed
lookups reject the wrong kind. Any malformed candidate, ambiguous combined entry, or response with
more than 1,000 entries rejects the complete response as `invalid-response`; partial results are
never returned or cached.

## Ordering, Paging, and Empty Results

The action preserves Lidarr's upstream order, removes later duplicates by `(kind, foreignId)`, and
assigns contiguous ranks before applying `offset` and `limit`. Paging is local because these Lidarr
lookup operations return a complete collection.

The result reports:

- `total`: complete count after validation and deduplication, before paging;
- `limit` and `offset`: effective local page controls;
- `returned`: candidates in the current page; and
- `hasMore`: whether another ranked candidate exists after the page.

A successful `[]` response is a valid empty result and is cacheable. An offset beyond the final
candidate also returns an empty page while preserving the true `total`.

## Human Output

Default text output is written to stderr and includes the query, candidate table, paging summary,
provider provenance, and execution summary. Combined search includes a `Kind` column; typed lookup
omits it because every row has the same kind.

```text
Lidarr Search: Björk

#  Kind    Name   Artist  Type    Details           Lidarr ID  MusicBrainz ID
1  artist  Björk  -       Person  Icelandic singer  8          87e748f1-...
2  album   Debut  Björk   Album   1993-07-05        -          714f3359-...

Results: 2 returned · offset 0 · total 2
Provider: lidarr
Execution: metadata-dependent lane · 1 attempt
```

An empty page prints `No results.` followed by the same paging, provider, and execution summaries.
Candidate names may be shortened for the terminal table; identifiers are preserved.

## Machine Output

JSON and YAML use the command's stable ID and preserve the same nested result:

```json
{
  "command": "lidarr-search",
  "result": {
    "query": {
      "mode": "search",
      "term": "Björk"
    },
    "results": [
      {
        "kind": "artist",
        "foreignId": "87e748f1-300e-46e4-9524-a4a65d68ae24",
        "name": "Björk",
        "rank": 1,
        "lidarrId": 8,
        "disambiguation": "Icelandic singer",
        "artistType": "Person"
      }
    ],
    "total": 1,
    "limit": 50,
    "offset": 0,
    "returned": 1,
    "hasMore": false,
    "provider": {
      "requested": "lidarr",
      "used": "lidarr",
      "degraded": false
    },
    "execution": {
      "taskId": "lidarr-search",
      "operation": "lidarr search",
      "lane": "metadata-dependent",
      "outcome": "succeeded",
      "attempts": 1
    }
  }
}
```

Machine formats write to stdout without mixing in human tables or warnings. CSV uses a fixed flat
schema with:

1. one `rowType=summary` row containing query, page, provider, cache, and execution fields; then
2. zero or more `rowType=candidate` rows containing the candidate fields.

The summary row is always present, including for an empty page. The shared CSV formatter protects
spreadsheet formula cells while preserving complete names and identifiers.

## Live Execution and Cache Fallback

Search and lookup run in the `metadata-dependent` execution lane. One scheduler preflight checks the
shared persisted Lidarr and metadata circuits before the first live attempt. The scheduler then owns
the idempotent retry budget and delay timing.

Each successful live attempt validates, deduplicates, and ranks the complete projection before a
non-fatal cache write. The cache row is isolated by:

```text
canonical Lidarr origin
  × category "lookup"
  × "v1:<mode>:<sha256(NFC-normalized-term)>"
```

Paging, cleartext terms, and API keys are not stored in the discriminator. The complete pre-page
projection, including `[]`, is stored so every page uses the same row.

Live Lidarr is always attempted first. The cache is consulted at most once, only after preflight
rejection or scheduler retry exhaustion. Serving a cached result requires all of the following:

- explicit `--allow-stale` consent;
- cache support enabled by a positive configured cache TTL;
- an exact origin, mode, normalized-term, and projection-version match;
- a row within the configured stale ceiling;
- a strictly revalidated complete cached projection; and
- a final `lidarr-unreachable`, `timeout`, or `metadata-provider-unavailable` failure.

Authentication, authorization, rate limiting, not-found, invalid-response, validation,
configuration, unknown failures, and cancellation never serve cache. A missing, corrupt, expired,
or wrong-query row preserves the original typed failure. Cache read and write failures also never
replace a live result or the original failure.

When fallback succeeds, the command exits successfully, emits one warning on stderr, and reports
degraded provenance:

```json
{
  "provider": {
    "requested": "lidarr",
    "used": "sqlite-cache",
    "degraded": true,
    "fallbackReason": "timeout"
  },
  "cacheStatus": {
    "source": "stale-cache",
    "fetchedAt": "2026-07-23T12:00:00.000Z",
    "ageSeconds": 90
  },
  "execution": {
    "taskId": "lidarr-search",
    "operation": "lidarr search",
    "lane": "metadata-dependent",
    "outcome": "succeeded",
    "attempts": 2
  }
}
```

`execution.attempts` remains exact. A preflight fallback reports `0`; a fallback after two live
attempts reports `2`.

## Failures and Cancellation

Failures use the existing Lidarr typed error taxonomy and exit code 1. Machine output includes the
command ID, sanitized message, code, and available execution metadata. API keys,
credential-bearing URLs, query terms in cache keys, response bodies, and generated envelopes are
not exposed.

A caller cancellation is forwarded through the scheduler and generated request. A pre-aborted or
queued operation does not start live work; an in-flight cancellation stops the request.
Cancellation is not retried and never invokes terminal cache fallback.

## No Mutation or Direct Provider Access

These commands issue only the generated Lidarr search and lookup `GET` operations. They do not call
MusicBrainz, Last.fm, or another provider directly. Discovery, interactive selection, library
filtering, and all artist or album mutations remain outside this feature.

For implementation details, see [Lidarr Generated Client](lidarr-generated-client.md) and
[Lidarr Execution Lanes](lidarr-execution-lanes.md).
