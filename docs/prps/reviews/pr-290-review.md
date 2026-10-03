# PR Review — #290

**Reviewed**: 2026-07-28T04:06:36Z
**Mode**: Pull request
**Author**: yandy-r
**Branch**: issue-208-plex-lidarr-reconcile → master
**Head**: `b7ebca5fd89bd04a8385db683f2d0cc9b5aa778d` plus final review fixes
**Decision**: APPROVE

## Summary

Three independent review passes found no critical or high defects. They identified four medium
contract defects in duplicate evidence, bounded read-only database loading, corrupt cache
classification, and Fish global-option routing, plus one low public-export omission. A focused
post-fix review found two deeper edge cases in JSON boolean coercion and the database stat/read
window. GitHub's automated review then found two additional edge cases in root-level offline
credential expansion and normalized candidate byte bounds; a third thread duplicated F001. All nine
unique findings are fixed. A final independent pass caught and fixed one regression in the initial
offline credential repair: configured origin templates must still resolve.

## Findings

### CRITICAL

_None._

### HIGH

_None._

### MEDIUM

- **[F001]** `packages/rfmedia-cli/src/lib/bridge/reconcile.ts:405` — Plex artists sharing one
  source MusicBrainz ID are emitted as unrelated one-member duplicate findings with no MBID.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Preserve canonical duplicate-source MBID evidence through snapshot
    projection, group outcomes by MBID, and emit one deterministic finding containing all members.

- **[F002]** `packages/rfmedia-cli/src/lib/db.ts:164` — The immutable read-only database path loads
  the entire tracking database into memory without a pre-read size bound.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Enforce and document a database snapshot size limit before `readFileSync`,
    with an oversized sparse-file regression.

- **[F003]** `packages/rfmedia-cli/src/lib/bridge/cache.ts:99` — Current-version malformed payloads
  excluded from scope discovery are later reported as version-incompatible instead of the stable
  `corrupt-payload` cache contract.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Distinguish current-version corrupt rows from genuinely incompatible
    versions and add invalid-JSON and malformed-metadata regressions.

- **[F004]** `packages/rfmedia-cli/src/lib/shell-completions/fish.ts:1161` — The Fish predicate
  assumes `lidarr reconcile` occupies tokens two and three, so root global options placed before the
  command suppress reconciliation completions.
  - **Status**: Fixed
  - **Category**: Compatibility
  - **Suggested fix**: Parse past root flags and their values before checking the command path, with
    coverage for `--json` and `--output json` forms.

### LOW

- **[F005]** `packages/rfmedia-cli/src/types/index.ts:388` — The public type barrel omits
  `ReconciliationReviewSuggestedItem` and `ReconciliationPlexOnlyItem`, even though the public result
  type exposes both.
  - **Status**: Fixed
  - **Category**: API Completeness
  - **Suggested fix**: Re-export both named bucket types from `types/index.ts`.

## Post-Fix Findings

### MEDIUM

- **[F006]** `packages/rfmedia-cli/src/lib/bridge/cache.ts:99` — SQLite treats JSON `true` as
  numeric `1`, allowing boolean normalization or scoring metadata through a value-only compatible
  query.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Require integer JSON types as well as exact values under `json_valid`, and
    add boolean-version regressions.

- **[F007]** `packages/rfmedia-cli/src/lib/db.ts:167` — A path-based stat followed by
  `readFileSync` leaves a replacement/growth window before the bounded snapshot is allocated.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Open once with no-follow semantics, fstat and read through that descriptor,
    bound the allocation from the descriptor size, and verify descriptor/path stability.

## GitHub Review Findings

### HIGH

- **[F008]** `packages/rfmedia-cli/src/cli.ts:141` — Root configuration loading eagerly expands
  unavailable Plex and Lidarr credential templates before the offline reconciliation action can
  honor its no-credentials contract.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Preserve secret templates for `lidarr reconcile --offline`, avoid caching
    that unexpanded configuration, and retain eager expansion for every live command.

### MEDIUM

- **[F009]** `packages/rfmedia-cli/src/lib/bridge/cache-codec.ts:266` — Candidate
  `normalizedTitle` values use the raw title byte bound even though entity decoding can expand
  normalized text beyond that limit.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Validate candidates against the normalized-title bound and cover a maximum
    raw title whose normalization expands.

The remaining GitHub thread about duplicate source MBIDs maps to F001 and was already fixed in
`b7ebca5f`.

## Final Fix Review

### HIGH

- **[F010]** `packages/rfmedia-cli/src/lib/config.ts:4031` — Preserving every template in
  credential-free mode also preserves configured Plex and Lidarr URL templates, preventing offline
  scope selection even when those origin environment variables are available.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Resolve only parsed `plex.url` and `lidarr.baseUrl` fields, keep credential
    templates inert, and cover templated origins with missing credential variables.

## Validation Results

| Check                              | Result     |
| ---------------------------------- | ---------- |
| PR title                           | Pass       |
| GitHub benchmark job               | Pass       |
| GitHub test job                    | Pass       |
| GitHub review findings             | Fixed (3)  |
| Independent review passes          | 3          |
| Critical or high review findings   | 0          |
| Final targeted regression suites   | Pass (238) |
| Full local test chain              | Pass       |
| Lint, typecheck, format, and build | Pass       |
| Final focused review               | Approve    |

## Files Reviewed

- Complete PR diff from `origin/master` through the final review-fix head
- Reconciliation mapping, snapshot codec, cache selection, pure engine, action, command, and types
- Bash, Zsh, and Fish completion templates and parity tests
- Feature documentation, ROADMAP, implementation plans, and prior local review/fix artifacts
