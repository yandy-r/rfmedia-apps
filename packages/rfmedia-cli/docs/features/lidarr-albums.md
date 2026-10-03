# Lidarr Albums

## Overview

`rfmedia lidarr albums` lists albums from the configured Lidarr instance with album-type,
monitored-state, and file filtering. It is read-only: it does not add albums, change monitoring,
edit release policy, delete anything, or enter the plan/apply workflow.

```bash
rfmedia lidarr albums --artist-ids 12 --types singles,eps --unmonitored
rfmedia lidarr albums --all --unmonitored --no-files --limit 100 --offset 200 --output json
rfmedia lidarr albums --album-ids 55,102 --output csv
```

The command emits the standard `{command: "lidarr-albums", result}` envelope for machine formats and
a human table on stderr. Global `--json` and `--output <format>` options apply.

## Selection Scope

Exactly one selection scope is required and is enforced before any client or scan work begins.
Passing zero or more than one scope fails locally with
`Choose exactly one selection scope: --artist-ids, --album-ids, or --all`.

| Scope          | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `--artist-ids` | List albums for the given comma-separated Lidarr artist IDs                 |
| `--album-ids`  | List exactly the given comma-separated album IDs (conflicts with `--types`) |
| `--all`        | Scan the whole library per-artist — an explicit, deliberate opt-in          |

`--all` never issues an unpaginated whole-library request. The scan iterates per-artist so each
response stays within the transport cap, and any failed or skipped artist read aborts the listing
rather than returning a silently partial page. See [Pagination and Ordering](#pagination-and-ordering).

## Filters

Filters combine with AND semantics across dimensions. All are optional and independent of the scope.

| Filter           | Meaning                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `--types <list>` | Comma-separated album-type selectors; OR within the list               |
| `--monitored`    | Only monitored albums (conflicts with `--unmonitored`)                 |
| `--unmonitored`  | Only unmonitored albums (conflicts with `--monitored`)                 |
| `--has-files`    | Only albums with at least one track file (conflicts with `--no-files`) |
| `--no-files`     | Only albums with no track files (conflicts with `--has-files`)         |

`--types` accepts the same closed, case-insensitive selector vocabulary as the album-monitoring
plan; singular aliases (`single`, `ep`, …) are canonicalized. Primary-type selectors: `albums`,
`eps`, `singles`, `broadcasts`, `others`. Secondary-type selectors: `compilations`, `live`,
`remixes`, `soundtracks`, `demos`, `mixtapes`. `--types` conflicts with `--album-ids`.

File filtering reads `statistics.trackFileCount`: an album counts as having files when that count is
greater than zero. Absent statistics count as zero files, so such albums match `--no-files` and are
excluded by `--has-files`.

## Pagination and Ordering

Albums are sorted by a fixed, deterministic key — artist ID ascending, then album ID ascending —
before `--limit` and `--offset` are applied. This makes paging windows stable across invocations.

| Option         | Default | Description                                     |
| -------------- | ------- | ----------------------------------------------- |
| `--limit <n>`  | `50`    | Maximum albums to return after the sort         |
| `--offset <n>` | `0`     | Number of sorted albums to skip before the page |

Paging is client-side. Lidarr's `GET /api/v1/album` endpoint has no server pagination, so the
command scans per-artist and windows the fully sorted result locally. `total` reflects the complete
matched count before paging; `returned` reflects the current page. An offset beyond the final album
returns an empty page while preserving the true `total`. There are no sort flags — the fixed order
delivers stable pagination without inflating the option surface.

## Options

| Option                   | Default | Description                                    |
| ------------------------ | ------- | ---------------------------------------------- |
| `--artist-ids <ids>`     | —       | Selection scope: artist IDs                    |
| `--album-ids <ids>`      | —       | Selection scope: exact album IDs               |
| `--all`                  | Off     | Selection scope: whole-library per-artist scan |
| `--types <list>`         | —       | Album-type selectors (OR within the list)      |
| `--monitored`            | Off     | Only monitored albums                          |
| `--unmonitored`          | Off     | Only unmonitored albums                        |
| `--has-files`            | Off     | Only albums with at least one track file       |
| `--no-files`             | Off     | Only albums with no track files                |
| `--limit <n>`            | `50`    | Maximum albums to return                       |
| `--offset <n>`           | `0`     | Number of sorted albums to skip                |
| `--lidarr-url <url>`     | Config  | Override the configured Lidarr base URL        |
| `--lidarr-api-key <key>` | Config  | Override the configured Lidarr API key         |

There is deliberately no `--allow-stale`: album listings are uncached, so there is no album
metadata-cache category to fall back to. Scope and paging values are validated locally before any
Lidarr request.

## Human Output

Default text output goes to stderr and includes the album table plus a scan/window summary line and
the execution summary. The table has these columns:

| Column      | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `Album ID`  | Local Lidarr album ID                                |
| `Album`     | Album title (shortened for the terminal if needed)   |
| `Artist`    | Resolved artist name                                 |
| `Type`      | Album type, or `-` when absent                       |
| `Monitored` | `Yes` or `No`                                        |
| `Files`     | `trackFileCount/trackCount` (absent statistics as 0) |
| `Size`      | Size on disk via the shared byte formatter           |
| `Release`   | Release date (`YYYY-MM-DD`), or `-` when absent      |

The summary line reports how many artists and albums were scanned and how many albums were returned
of the true total at the current offset. An empty page prints a no-match notice with the same
scan/window summary.

## Machine Output

JSON and YAML use the command's stable ID and preserve the nested result:

```json
{
  "command": "lidarr-albums",
  "result": {
    "albums": [
      {
        "id": 55,
        "title": "Debut",
        "artistId": 8,
        "artistName": "Björk",
        "albumType": "Album",
        "monitored": true,
        "anyReleaseOk": false,
        "statistics": { "trackFileCount": 11, "trackCount": 11, "sizeOnDisk": 402653184 },
        "releaseDate": "1993-07-05T00:00:00Z",
        "foreignAlbumId": "714f3359-9769-3b2b-8c8e-2f0c5c8f0e2a"
      }
    ],
    "total": 1,
    "scanned": { "artists": 1, "albums": 1 },
    "pagination": { "limit": 50, "offset": 0, "returned": 1 },
    "execution": {
      "taskId": "lidarr-albums",
      "operation": "lidarr albums",
      "lane": "local-only",
      "outcome": "succeeded",
      "attempts": 1
    }
  }
}
```

Machine formats write to stdout without mixing in human tables. CSV emits multiple rows: one
`rowType=summary` row carrying page, scan, and execution fields, followed by zero or more
`rowType=album` rows. The summary row is always present, including for an empty page. The shared CSV
formatter protects spreadsheet formula cells while preserving complete titles and identifiers.

## Failures

Failures use the existing Lidarr typed error taxonomy and exit code 1. Machine output includes the
`lidarr-albums` command ID, the sanitized message, code, and available execution metadata. API keys,
credential-bearing URLs, and response bodies are never exposed; the API key is redacted from any
diagnostic. Scope, filter conflicts, and invalid paging values fail locally before any Lidarr I/O.

## No Mutation or Caching

`lidarr albums` issues only read requests. Monitoring, release-policy edits, and deletion live in the
sealed plan/apply workflow — see
[Lidarr Mutation Plan/Apply](lidarr-plan-apply.md). For implementation details, see
[Lidarr Generated Client](lidarr-generated-client.md) and
[Lidarr Execution Lanes](lidarr-execution-lanes.md).
