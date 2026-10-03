# UX Research: Lidarr Search and Lookup

## Executive Summary

Issue #222 should expose one predictable read-only hierarchy:
`rfmedia lidarr search {artist|album|all}`. Each leaf requires exactly one explicit query mode,
`--term <text>` or `--mbid <uuid>`, uses the existing `--limit`/`--offset` vocabulary, and preserves
Lidarr's relevance order. This is easier to discover and script than mixing positional terms,
endpoint names, and provider-specific flags.

Human output should answer four questions immediately: what was searched, what matched, where the
data came from, and whether it is degraded. JSON and YAML should emit a versioned envelope; CSV
should use a fixed flat row contract. Human tables remain on stderr and machine data remains the
only stdout content. A successful stale-cache recovery is exit 0 with a visible warning and
structured degradation fields; failure without usable results is exit 1 with a classified,
actionable recovery message.

This design deliberately excludes direct metadata-provider configuration, provider discovery, and
add/import mutations covered by #220, #203, and #204.

**Confidence**: High. The proposal follows the current Lidarr command, formatter, failure,
resilience, and shell-completion contracts, plus the endpoint constraints documented in
`research-external.md`.

## User Workflows

### Recommended Command Grammar

```text
rfmedia lidarr search artist (--term <text> | --mbid <uuid>) [options]
rfmedia lidarr search album  (--term <text> | --mbid <uuid>) [options]
rfmedia lidarr search all    (--term <text> | --mbid <uuid>) [options]

Options:
  --term <text>        Search metadata by name/title text
  --mbid <uuid>        Exact MusicBrainz identifier lookup
  --limit <n>          Maximum returned rows (default 50)
  --offset <n>         Number of ranked rows to skip (default 0)
  --allow-stale        Permit stale cached results during a dependency failure
  --lidarr-url <url>   Existing connection override
  --lidarr-api-key <key> Existing credential override
```

- `artist` and `album` use the dedicated lookup endpoints; `all` uses the polymorphic combined
  endpoint and keeps a `kind` discriminator on every row.
- Exactly one of `--term` and `--mbid` is required. Explicit flags make intent, validation errors,
  help text, shell history, and future compatibility unambiguous.
- Accept a bare UUID only through `--mbid`; the CLI canonicalizes it to Lidarr's supported lookup
  syntax internally. Do not ask users to know `lidarr:`, `lidarrid:`, or `mbid:` prefixes.
- Trim outer whitespace from `--term`, reject empty/oversized/terminal-unsafe values, but preserve
  meaningful punctuation and internal spacing.
- Validate `--mbid` locally as a UUID and print `Invalid MusicBrainz ID: expected a UUID`, not a
  misleading empty result.
- Do not add `--provider`, `--fallback-provider`, `--add`, profile, root-folder, monitoring, or
  import flags in this issue.

**Confidence**: High. This maps cleanly to all three Lidarr operations without exposing their URL
shape or creating future mutation ambiguity.

### Ordering and Pagination

- Preserve upstream relevance order by default and expose a 1-based `rank` assigned before slicing.
- Do not add a sort flag in v1. Alphabetical sorting would discard relevance and date sorting is
  undefined for artists and partially populated albums.
- Apply `offset` then `limit` locally because the lookup endpoints are not natively paginated.
- Defaults should match `lidarr list`: `limit=50`, `offset=0`. Bound `limit` to a documented safe
  maximum; reject zero, negative, fractional, and unsafe integers before network access.
- Return `total`, `limit`, `offset`, `returned`, and `hasMore`. An offset beyond the result set is a
  successful empty page, not an error.
- Cache the complete ranked result set by canonical query, then paginate. Never cache individual
  pages, which would make totals and page-size changes inconsistent.

**Confidence**: High. The endpoint and current CLI constraints are direct code/API evidence.

### Human Output

Artist table:

```text
Lidarr Artist Search
Query: term "Massive Attack"  Source: Lidarr metadata  Results: 2 of 2

Rank  Artist           Disambiguation  Type    MBID
1     Massive Attack  Bristol group   Group   10ad...
2     Massive Attack  US group        Group   4f8a...
```

Album table:

```text
Rank  Album       Artist           Type   Released    MBID
1     Mezzanine   Massive Attack   Album  1998-04-20  28e2...
```

Unified output adds `Kind` as the first data column. Show only stable decision fields; leave
overview, genres, links, images, releases, and local configuration to machine output or later
detail commands. Truncate by display width using the repository's Unicode-aware helper, never by
raw UTF-16 length. Always print full identifiers.

The heading, query summary, table, pagination footer, provenance/degradation notice, and execution
summary go to stderr, consistent with current Lidarr commands. `text` and `table` may share this
renderer in v1.

**Confidence**: High. This extends the existing `lidarr list` table pattern with lookup-specific
identity and provenance.

## Structured Output Contract

JSON and YAML should serialize the same envelope:

```json
{
  "schemaVersion": "lidarr-search.v1",
  "command": "lidarr-search-artist",
  "query": { "kind": "artist", "mode": "term", "value": "Massive Attack" },
  "page": { "limit": 50, "offset": 0, "returned": 1, "total": 1, "hasMore": false },
  "provenance": {
    "source": "lidarr",
    "freshness": "fresh",
    "degraded": false,
    "fallbackUsed": false,
    "fetchedAt": "2026-07-23T12:00:00.000Z"
  },
  "result": {
    "records": [
      {
        "kind": "artist",
        "rank": 1,
        "artistName": "Massive Attack",
        "foreignArtistId": "10adbe5d-6b17-4be1-99a9-2ffc3b2d555c"
      }
    ],
    "execution": { "lane": "metadata-dependent", "outcome": "succeeded", "attempts": 1 }
  }
}
```

- Keep property names and enum values identical across JSON and YAML.
- Additive fields may ship within `v1`; removals, renames, meaning changes, or record-shape changes
  require a new schema version.
- CSV uses fixed flat columns and one `recordType=summary` row followed by result rows. Repeat
  `schemaVersion`, `command`, query, page, and provenance fields on result rows. A no-match response
  still emits the summary row, so CSV does not lose totals/provenance.
- CSV record fields use dotted names such as `record.artistName`; neutralize formula-leading cells
  with the existing formatter and never JSON-stringify the entire result set into one cell.
- Successful JSON/YAML/CSV produces exactly one valid document/stream on stdout. Warnings,
  diagnostics, progress, and debug output never enter stdout.

**Confidence**: High. Versioning is justified because these commands are new; the stdout discipline
and CSV safety already exist in the repository.

### Feedback and State Design

### Provenance, Cache, and Degradation

Use stable fields rather than prose-only warnings:

- `source`: `lidarr` or `cache`; if a future implementation adds another source, name it explicitly.
- `freshness`: `fresh` or `stale`.
- `degraded`: boolean; true whenever the preferred live Lidarr lookup was not used successfully.
- `fallbackUsed`: boolean.
- `fetchedAt` and optional `ageSeconds` for cached results.
- Optional stable `degradedReason`: `lidarr-unreachable`, `metadata-provider-unavailable`,
  `rate-limited`, `timeout`, or `circuit-open`.

Fresh cache behavior may remain invisible except in structured provenance. Stale results require
explicit `--allow-stale`, a yellow human warning that does not rely on color, and all fields above.
Do not label a successful but possibly incomplete live text search as cached or invent outage
state; only explicit health/error signals establish degradation.

**Confidence**: High for disclosure requirements; Medium for whether fresh read-through cache is
used because that remains an implementation/product decision.

### Empty, Failure, and Recovery States

| State                        | Human message and recovery                                                               | Exit    |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ------- |
| No match                     | `No artists found for term "..."`. Suggest `--mbid` only when useful.                    | 0       |
| Empty page                   | `No results at offset 100 (10 total). Try --offset 0.`                                   | 0       |
| Bad term/MBID/paging         | State the invalid value class and expected syntax; no request.                           | nonzero |
| Metadata outage, no fallback | `Metadata provider unavailable. Retry later, use --mbid, or rerun with --allow-stale.`   | 1       |
| Rate limited                 | `Lidarr search rate-limited; retry after 120s.` Include retry time when known.           | 1       |
| Circuit open                 | Include stable reason and automatic retry-at time.                                       | 1       |
| Stale fallback served        | `Warning: showing cached results from <time> (<age> old); live metadata is unavailable.` | 0       |
| Local Lidarr unreachable     | Name Lidarr, not its metadata provider; suggest `lidarr health`.                         | 1       |

Machine failures retain the current `{command,error}` concept but add
`schemaVersion: "lidarr-search.v1"`, query kind/mode without secrets, lane, attempts, failure type,
retryability, and retry timing. Never include raw provider bodies, API keys, or URLs containing
credentials.

**Confidence**: High. These states follow the existing error taxonomy and resilience contract.

## Accessibility and Terminal Safety

- Never encode kind, freshness, degradation, or success using color alone; include words.
- Honor existing color suppression and the `NO_COLOR` convention. Machine formats contain no ANSI.
- Sanitize or reject C0/C1 controls and Unicode bidirectional controls in input and provider text.
- Bound all displayed fields, use display-width-aware truncation, and preserve full values in
  machine output.
- On narrow/non-TTY terminals, keep essential columns (`Kind`, name/title, artist, MBID) and omit
  optional columns before wrapping unpredictably.
- Avoid spinners for a single lookup. If progress is ever needed for fallback, render it only on an
  interactive stderr and clear it before the final result.
- Messages must remain understandable with a screen reader and when redirected as plain text.

**Confidence**: High. These requirements align with WCAG 2.2's non-color cue guidance and the
repository's terminal-safety controls.

## Shell Completion and Compatibility

Update Bash, Zsh, and Fish templates plus template snapshot/spec tests with `search`,
`artist|album|all`, and all leaf flags. Complete enum-like subcommands and output formats, but never
attempt network-backed term, MBID, artist, album, or provider completion. Help order should be
`artist`, `album`, `all`.

This is additive: preserve `status`, `list`, `wanted`, `health`, `plan`, `apply`, global
`--json`/`--output`, and current exit behavior. Do not overload `lidarr list` with remote discovery
or call response-local combined-search IDs durable Lidarr IDs.

**Confidence**: High. Static templates are the current repository contract.

## Testable UX Acceptance Criteria

1. Help exposes the three leaves and exactly-one query-mode rule.
2. Missing/conflicting modes and malformed MBIDs fail before any request.
3. Artist and album results use dedicated endpoints; `all` retains `kind`.
4. Default order matches upstream order and rank is assigned before paging.
5. `limit=50` and `offset=0` are reported even when omitted.
6. No-match and out-of-range pages exit 0 with deterministic empty records.
7. Human output writes no stdout; machine output writes no human text or ANSI.
8. JSON and YAML share `lidarr-search.v1`; CSV always includes a summary row.
9. Fresh, cached, stale, and degraded fixtures expose unambiguous provenance.
10. Outage, timeout, rate-limit, and circuit-open fixtures give distinct recovery text.
11. Stale fallback requires consent, warns on stderr, and exits 0 when usable.
12. Control/bidi text cannot alter terminal output; CSV formulas are neutralized.
13. CJK, combining marks, and emoji remain column-safe under width truncation.
14. Bash, Zsh, and Fish completion tests include every new command and option.
15. Existing Lidarr command and formatter regression suites remain unchanged in behavior.

## Sources and Freshness

- GitHub issue #222, opened before this research; read 2026-07-23.
- `docs/plans/lidarr-search-lookup/research-external.md`, generated 2026-07-23.
- Current repository files `commands/lidarr.ts`, `actions/lidarr/list.ts`, formatter/output docs, and
  Bash/Zsh/Fish completion templates; inspected 2026-07-23.
- [Command Line Interface Guidelines](https://clig.dev/), living guidance; accessed 2026-07-23.
- [WCAG 2.2, Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html),
  W3C Recommendation 2023-10-05; accessed 2026-07-23.
- [NO_COLOR](https://no-color.org/), informal standard; accessed 2026-07-23.

## Open Questions

- What hard maximum should `--limit` enforce: 100 or 200?
- Should a fresh cache be consulted before every network lookup or only after a live failure?
- Is `search all` required in the first release, or should polymorphic search follow the two typed
  leaves?
