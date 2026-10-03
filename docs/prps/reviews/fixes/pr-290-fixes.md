# Review Fix Report — PR #290

**Review artifact**: `docs/prps/reviews/pr-290-review.md`
**Branch**: `issue-208-plex-lidarr-reconcile`
**Threshold**: LOW
**Generated**: 2026-07-28T04:15:00Z

## Summary

| Metric             | Count |
| ------------------ | ----: |
| Total findings     |    10 |
| Fixed              |    10 |
| Failed             |     0 |
| Remaining findings |     0 |

All independent and GitHub review findings are resolved. One additional GitHub thread duplicated
F001 and is tracked against that existing fix.

## Fixed Findings

### F001 — Duplicate source MBIDs lose their collision group

- **Status**: Fixed
- **Files**:
  - `packages/rfmedia-cli/src/lib/bridge/mapping.ts`
  - `packages/rfmedia-cli/src/lib/bridge/cache-codec.ts`
  - `packages/rfmedia-cli/src/lib/bridge/reconcile.ts`
  - `packages/rfmedia-cli/src/lib/bridge/reconcile.test.ts`
- **Resolution**: Canonical duplicate-source MBID evidence survives resolution and snapshot
  projection, then produces one deterministic finding containing every affected Plex artist.
- **Validation**: Resolver-to-reconciliation regression passes.

### F002 — Read-only database snapshots have no pre-read memory bound

- **Status**: Fixed
- **Files**:
  - `packages/rfmedia-cli/src/lib/db.ts`
  - `packages/rfmedia-cli/src/lib/db.test.ts`
  - `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
- **Resolution**: Immutable database snapshots are capped at 256 MiB before allocation and the
  operator contract documents the fail-closed limit.
- **Validation**: Sparse oversized-file regression passes.

### F003 — Corrupt current snapshots are reported as version-incompatible

- **Status**: Fixed
- **Files**:
  - `packages/rfmedia-cli/src/lib/bridge/cache.ts`
  - `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`
- **Resolution**: Discovery distinguishes malformed current-version rows from valid incompatible
  versions and preserves the stable `corrupt-payload` classification.
- **Validation**: Invalid JSON and malformed metadata regressions pass.

### F004 — Fish assumes a fixed root command position

- **Status**: Fixed
- **Files**:
  - `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
  - `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- **Resolution**: The predicate skips root flags, attached values, and separate values before
  checking the `lidarr reconcile` command path.
- **Validation**: Bash, Zsh, and Fish parity suite passes 43 tests.

### F005 — Public barrel omits reconciliation bucket types

- **Status**: Fixed
- **Files**:
  - `packages/rfmedia-cli/src/types/index.ts`
- **Resolution**: Both public result bucket types are re-exported.
- **Validation**: Package type checking passes.

### F006 — Boolean JSON metadata passes numeric compatibility checks

- **Status**: Fixed
- **Files**:
  - `packages/rfmedia-cli/src/lib/bridge/cache.ts`
  - `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`
- **Resolution**: Compatibility requires integer JSON types and exact version values under a valid
  JSON guard.
- **Validation**: Boolean normalization and scoring version regressions pass.

### F007 — Database size checking has a stat/read race

- **Status**: Fixed
- **Files**:
  - `packages/rfmedia-cli/src/lib/db.ts`
- **Resolution**: The reader opens one no-follow descriptor, validates and bounds its fstat size,
  reads only through that descriptor, then verifies descriptor and path identity/stability.
- **Validation**: Database suite passes 57 tests; final focused review approved the implementation.

### F008 — Offline reconciliation expands unavailable credentials at startup

- **Status**: Fixed
- **Files**:
  - `packages/rfmedia-cli/src/cli.ts`
  - `packages/rfmedia-cli/src/cli.test.ts`
  - `packages/rfmedia-cli/src/lib/config.ts`
  - `packages/rfmedia-cli/src/lib/config.test.ts`
  - `packages/rfmedia-cli/docs/features/plex-lidarr-reconciliation.md`
- **Resolution**: The root hook detects only `lidarr reconcile --offline`, loads configuration
  without expanding or caching credential templates, and skips plugin initialization. All live
  commands retain eager secret expansion.
- **Validation**: Startup classification and missing-secret/cache-isolation regressions pass.

### F009 — Normalized candidate titles use the raw title bound

- **Status**: Fixed
- **Files**:
  - `packages/rfmedia-cli/src/lib/bridge/cache-codec.ts`
  - `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`
- **Resolution**: Snapshot candidates use the dedicated normalized-title byte limit.
- **Validation**: A maximum-size raw title whose entity decoding expands beyond the raw limit
  round-trips through the snapshot cache.

### F010 — Offline origin templates remain unresolved

- **Status**: Fixed
- **Files**:
  - `packages/rfmedia-cli/src/lib/config.ts`
  - `packages/rfmedia-cli/src/lib/config.test.ts`
- **Resolution**: Credential-free loading resolves only available parsed `plex.url` and
  `lidarr.baseUrl` fields while leaving credentials inert and omitting unavailable origins for
  explicit CLI overrides without discarding unrelated config. The result remains uncached.
- **Validation**: Templated origins resolve when URL variables exist and credential variables do
  not; a subsequent live load still fails on the missing credential.

## Validation

| Check                            | Result     |
| -------------------------------- | ---------- |
| Final targeted regression suites | Pass (238) |
| `npm run test:run`               | Pass       |
| `npm run lint`                   | Pass       |
| `npm run format:check`           | Pass       |
| `npm run build:all`              | Pass       |
| Package TypeScript compilation   | Pass       |
| Final focused code review        | Approve    |
| Unresolved GitHub review threads | 0          |
