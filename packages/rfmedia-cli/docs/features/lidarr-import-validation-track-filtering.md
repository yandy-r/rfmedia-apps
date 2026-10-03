# Lidarr Import Validation and Track Filtering

`rfmedia` provides two separate workflows around album acquisition:

- `lidarr validate-import` asks Lidarr's matching engine to inspect a local folder without importing
  or mutating anything.
- `lidarr plan track-filter` previews exact, album-scoped trackfile deletions and can seal them into
  the normal Lidarr plan/apply boundary.

## Validate an Import Folder

The folder must be visible to Lidarr at the same path:

```bash
rfmedia lidarr validate-import /incoming/Artist/Album
rfmedia lidarr validate-import /incoming/Artist/Album --artist-id 42
rfmedia --output json lidarr validate-import /incoming/Artist/Album --fail-on ambiguous
```

The read-only probe classifies every candidate:

| Status      | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `ready`     | One complete artist, album, release, and track match     |
| `unmatched` | Required matching evidence is missing                    |
| `ambiguous` | Multiple or conflicting track/parent matches remain      |
| `rejected`  | Lidarr returned at least one rejection for the candidate |

`--filter-existing-files` and `--replace-existing-files` are passed directly to Lidarr's manual
import probe. `--fail-on ready|unmatched|ambiguous|rejected` is an optional CI gate applied only
after the complete human or machine report is rendered.

The command does not import files, start searches, change monitoring, or write a plan.

## Preview Track Retention

Track filtering always targets one exact Lidarr album and requires explicit track IDs, a local
embedded-rating threshold, or both:

```bash
# Preview only; no artifact and no mutation
rfmedia lidarr plan track-filter \
  --album-id 4501 \
  --keep-track-ids 101,102 \
  --min-stars 3

# Seal exactly the reviewed deletion candidates
rfmedia lidarr plan track-filter \
  --album-id 4501 \
  --keep-track-ids 101,102 \
  --min-stars 3 \
  --out ./track-filter.json
```

Explicit track IDs always win. With both inputs, the retained set is the union of the explicit IDs
and files whose embedded rating meets `--min-stars`. Ratings are read from local managed paths and
normalized by the existing metadata reader.

The planner fails closed. Missing, unmapped, multiply mapped, cross-album, unrated, or unreadable
files are retained and reported as warnings. Unknown explicit IDs, parent-scope drift, an empty
retained set, or more deletion candidates than `--max-batch` reject the plan. The default maximum
is 100 exact trackfiles.

## Apply a Reviewed Filter

Review the sealed artifact, validate live state, then explicitly authorize file deletion:

```bash
rfmedia lidarr apply ./track-filter.json --dry-run

rfmedia lidarr apply ./track-filter.json \
  --allow-file-delete \
  --yes
```

Apply rechecks each planned trackfile's Lidarr ID, album, artist, path, size, and presence before
dispatch. It then calls Lidarr's exact trackfile bulk-delete operation once and verifies that every
target is absent. The operation is never retried automatically or placed in the deferred queue.
Inconclusive verification is `uncertain` and must be inspected or resumed with the reviewed plan.

`rfmedia` does not delete paths directly. Lidarr performs the managed-file deletion, and its API
provides no trash or recovery guarantee. `--allow-album-delete` is not required because the album
record itself is not deleted.

## Output and Completion

Text diagnostics go to stderr. JSON, YAML, and stable CSV projections use stdout. Bash, Zsh, and
Fish completions include the validation folder, status values, album/track IDs, half-star values,
batch limits, and artifact output path.
