# Plex-Lidarr Reconciliation

## Overview

`rfmedia lidarr reconcile` compares every artist in one Plex music library with the complete artist
catalog from one Lidarr instance. It reports exact matches, review evidence, directional gaps,
uncertainty, optional duplicate identity findings, and inert follow-up suggestions.

The command is report-only. It never adds, removes, merges, retags, monitors, or unmonitors an
artist; triggers a Plex scan; changes files; or creates or applies a plan. A successful live run
does replace one observational SQLite snapshot after both catalogs validate. That cache write
supports later offline reports and is not a provider mutation.

## Live Use

A live run requires one explicit Plex music-library name:

```bash
rfmedia lidarr reconcile --plex-library Music
```

Plex and Lidarr connection settings normally come from configuration. They can be overridden for
one live run:

```bash
rfmedia lidarr reconcile \
  --plex-library Music \
  --plex-url http://plex.example:32400 \
  --plex-token "$PLEX_TOKEN" \
  --lidarr-url http://lidarr.example:8686 \
  --lidarr-api-key "$LIDARR_API_KEY"
```

The command reads the Plex instance ID, pages the selected library to completion, reads the complete
Lidarr artist catalog, resolves identities, validates snapshot v2, and atomically replaces the
same-scope cached generation. A partial, stalled, cancelled, invalid, or failed provider read
produces no report and does not replace the prior snapshot. A live failure never falls back to
cache.

## Offline Use

Offline mode reads cached evidence only:

```bash
rfmedia lidarr reconcile --offline
```

The Plex and Lidarr origins still come from configuration or from `--plex-url` and `--lidarr-url`.
Origin resolution does not require credentials. `--offline` rejects `--plex-token`,
`--lidarr-api-key`, and the live-only `--plex-library` selector.
Root configuration loading resolves only available Plex and Lidarr origin templates, omits
unavailable configured origins so explicit CLI values can replace them, preserves quoted credential
templates, and skips plugin initialization in offline mode. Live commands retain eager, fail-closed
secret expansion.

The cache lookup filters snapshot-v2 metadata by canonical Plex origin, canonical Lidarr origin,
and artist entity kind. `--plex-library-id <id>` can narrow the lookup by the stable Plex section
ID:

```bash
rfmedia lidarr reconcile --offline --plex-library-id 3
```

Exactly one compatible full scope must remain. The command never chooses the newest row or merges
machines or libraries. Zero matches fail as `missing-compatible-snapshot`; multiple matches fail as
`ambiguous-snapshot-scope` and show bounded safe scope details. Use the reported library IDs to
retry with `--plex-library-id`.

Offline reports retain the exact Plex instance and library IDs, capture and verification times, and
age in seconds. Their provenance is always `sqlite-cache` / `offline` / `stale`, regardless of age.
Offline mode constructs no provider client or scheduler, performs no network request or migration,
and opens the tracking database read-only.

Snapshot v1 cannot name every Lidarr-only artist and is incompatible with this command. Run one
successful live reconciliation to refresh that scope as snapshot v2; old rows are never guessed,
merged, or upgraded during an offline read.

## Options

| Option                   | Mode    | Description                                                   |
| ------------------------ | ------- | ------------------------------------------------------------- |
| `--plex-library <name>`  | Live    | Required Plex music-library selector                          |
| `--plex-library-id <id>` | Offline | Optional stable cached library discriminator                  |
| `--offline`              | Offline | Use cached evidence with no provider I/O                      |
| `--duplicates`           | Both    | Include bridge-owned duplicate identity findings              |
| `--plex-url <url>`       | Both    | Override the canonical Plex origin                            |
| `--plex-token <token>`   | Live    | Override the Plex token; rejected offline                     |
| `--lidarr-url <url>`     | Both    | Override the canonical Lidarr origin                          |
| `--lidarr-api-key <key>` | Live    | Override the Lidarr API key; rejected offline                 |
| `-v, --verbose`          | Both    | Show every human detail row instead of the bounded first rows |

Global `--json` and `--output <json|yaml|csv|table|text>` options retain their normal behavior.
There is no `--apply`, `--yes`, `--allow-stale`, threshold, or fail-on-gap option.

## Evidence and Directional Gaps

A unique one-to-one artist MusicBrainz ID join is the only authoritative result. It appears in
`matchedExact` with category `authoritative` and method `exact-mbid`.

Normalized-name and fuzzy-name matches appear only in `reviewSuggested`. Their scores are similarity
evidence from 0 through 1, not probabilities or confidence. Ambiguous candidates, malformed or
contradictory identity evidence, and unavailable evidence remain explicit rather than selecting a
target.

The gap rules are directional:

- `plexOnly` contains every Plex artist without an authoritative exact match, including artists
  that also appear in review, ambiguity, conflict, or unavailable arrays.
- `lidarrOnly` contains every Lidarr artist not consumed by an authoritative exact match.
- A normalized or fuzzy suggestion therefore remains in both directional gaps until reviewed
  outside this command.

Primary outcomes, directional gaps, duplicates, and suggestions overlap. Do not add their summary
counts to calculate a catalog total; use `sourceArtistCount`, `targetArtistCount`, and
`primaryOutcomeCount`.

| Category                 | Meaning                                                  | Authoritative |
| ------------------------ | -------------------------------------------------------- | ------------- |
| `authoritative`          | Unique exact artist-MBID join                            | Yes           |
| `review-normalized-name` | Unique normalized-name evidence                          | No            |
| `review-fuzzy-name`      | Threshold-and-margin-qualified fuzzy evidence            | No            |
| `ambiguous`              | Multiple or insufficiently separated candidates          | No            |
| `unmatched`              | Complete evidence produced no authoritative match        | No            |
| `conflict`               | Malformed, duplicate, or contradictory identity evidence | No            |
| `unavailable`            | Required compatible evidence could not be trusted        | No            |

## Duplicate Findings

Duplicate enrichment is off by default. Add `--duplicates` to include bridge-owned identity
evidence:

```bash
rfmedia lidarr reconcile --plex-library Music --duplicates
```

The stable duplicate codes are:

- `duplicate-source-mbid`
- `duplicate-target-mbid`
- `source-normalized-name-collision`
- `target-normalized-name-collision`
- `contradictory-name-mbid`

These findings do not change the primary classifications or directional gaps. Deep Lidarr path,
album, file, and folded-name checks remain in
`rfmedia lidarr audit --check duplicate-identity`.

## Output Schemas

Human output is written to stderr. It shows mode, complete provider scope, timestamps, offline cache
age, summary counts, evidence sections, and inert suggestions. Detail sections show at most 20 rows
by default; `--verbose` removes presentation truncation but does not remove acquisition limits.

JSON and YAML write one prose-free document to stdout:

```json
{
  "command": "lidarr-reconcile",
  "result": {
    "schema": "rfmedia.plex-lidarr-reconciliation.v1",
    "scope": {},
    "provenance": {},
    "capturedAt": "2026-01-01T00:00:00.000Z",
    "verifiedAt": "2026-01-01T00:00:00.000Z",
    "completeness": {},
    "summary": {},
    "matchedExact": [],
    "reviewSuggested": [],
    "reviewAmbiguous": [],
    "plexOnly": [],
    "lidarrOnly": [],
    "conflicts": [],
    "unavailable": [],
    "duplicates": [],
    "suggestions": []
  }
}
```

A live result also includes `result.execution`; an offline result does not. Identity items expose a
stable category, reason, method, safe source and target projections, nullable score and runner-up
margin, and bounded candidates. The output excludes credentials, raw provider records, GUID URLs,
paths, and response bodies.

CSV uses a fixed flat schema. Rows are ordered as:

1. one `summary` row;
2. one `item` row per logical classification in stable category order;
3. optional `duplicate` rows;
4. `suggestion` rows.

Every row includes `command`, `rowType`, schema, scope, provenance, timestamps, completeness, summary,
and optional live execution columns. Item, duplicate, and suggestion columns use `item.*`,
`duplicate.*`, and `suggestion.*` prefixes. Candidate, member, and argv arrays are JSON-encoded
cells. Review rows are emitted once even though they also participate in directional gap counts.

## Exit Behavior

- Exit code `0` means a complete report was produced. Gaps, review suggestions, ambiguity,
  conflicts, unavailable artist evidence, and duplicates are report data and do not fail the
  command.
- Exit code `1` covers invalid option combinations, missing capability or configuration, provider
  failure, incomplete evidence, cache persistence failure, cancellation, and missing, ambiguous,
  incompatible, or corrupt offline scope.

The command has no implicit CI policy for findings. Machine failures use the standard redacted
Lidarr error envelope.

## Safety and Follow-Up Boundaries

Suggestion records are inert data. Their `argv` fields are argument arrays for inspection,
metadata review, or duplicate audit; they are not executed and never contain
`rfmedia lidarr apply`.

Issue #208 owns only observation and reporting. Consumption-driven policy and mutation remain in
[#209](https://github.com/yandy-r/rfmedia-apps/issues/209); rating-driven monitoring and
quality-profile changes ship as `rfmedia lidarr sync-ratings` — see
[Lidarr Ratings Sync](lidarr-ratings-sync.md), which reads this identity bridge and writes only
through the sealed plan/apply lifecycle. Any future write must use that lifecycle and fresh live
exact-identity revalidation. Cached reconciliation evidence never authorizes a mutation.

## Troubleshooting

| Failure                        | Operator action                                                      |
| ------------------------------ | -------------------------------------------------------------------- |
| Live library selector missing  | Add `--plex-library <name>`                                          |
| Offline/live selector conflict | Use `--plex-library` live or `--plex-library-id` with `--offline`    |
| Offline credential conflict    | Remove `--plex-token` and `--lidarr-api-key`                         |
| Missing compatible snapshot    | Run one successful live reconciliation for the same origins          |
| Ambiguous snapshot scope       | Retry with one reported `--plex-library-id`                          |
| Incompatible snapshot          | Refresh the scope online to write snapshot v2                        |
| Corrupt or unreadable cache    | Preserve the failure evidence and refresh with a successful live run |

## Related Documentation

- [Lidarr Library Health Audit](lidarr-audit.md)
- [Centralized Tracking Database](centralized-tracking-db.doc.md)
