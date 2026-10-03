# Technical Research: Plex Config Validation (#289)

## Executive Summary

`PlexConfigOptions` declares `pageSize`, `syncRatingsOnCopy`, and
`syncOnCopyDefaults`, but `validatePlexConfigOptions` never reads them, so the production config
boundary silently removes values that downstream code already consumes. The narrow fix is to
validate and retain those fields in `packages/rfmedia-cli/src/lib/config.ts`, add a top-level
compile-time coverage fence, and prove the boundary with focused tests.

The wider config audit found one additional dropped declared field:
`CopyConfigOptions.conflictStrategy`. It is outside #289 and has no matching existing issue in the
live issue search; #289's acceptance criteria therefore require a separate follow-up issue before
closeout.

## Architecture Design

The existing flow remains unchanged:

```text
.rfmedia.yaml
  -> validateConfig()
  -> validatePlexConfigOptions()
  -> loaded ConfigFile.plex
  -> adapter/copy consumers
```

- `validateConfig` performs the `plex` container-shape check and delegates at
  `packages/rfmedia-cli/src/lib/config.ts:4297`.
- `validatePlexConfigOptions` constructs a fresh allowlisted object at
  `packages/rfmedia-cli/src/lib/config.ts:1202`; the missing branches belong here.
- `pageSize` flows through `packages/rfmedia-cli/src/lib/adapters/index.ts:220-273` into
  `PlexAdapter`, which supplies it to query/library, identity, playlist, and collection capability
  factories at `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts:283-315`.
- `syncRatingsOnCopy` and `syncOnCopyDefaults` supply defaults to Plex copy at
  `packages/rfmedia-cli/src/actions/plex-copy.ts:223-248` and playlist export at
  `packages/rfmedia-cli/src/actions/plex-playlist.ts:296-328`. Explicit action/CLI values retain
  precedence.

No consumer, command, queue, persistence, or adapter contract should change. Validation must not
write defaults into the returned config; consumers continue applying `false`, `"no@email"`, and
`"normalized"` with `??`.

## Data Models/Config Shapes

Source of truth: `packages/rfmedia-cli/src/types/config.ts:228-306`.

```ts
interface PlexSyncOnCopyDefaults {
  popmEmail?: string;
  vorbisScale?: "normalized" | "stars" | "percent";
}

interface PlexConfigOptions {
  // existing fields omitted
  pageSize?: number;
  syncRatingsOnCopy?: boolean;
  syncOnCopyDefaults?: PlexSyncOnCopyDefaults;
}
```

`pageSize` is Plex API paging, not `InteractiveConfig` pagination. The latter deliberately uses
5–100 via `validatePageSize` (`config.ts:108-114,285-308`); Plex paging must instead be a positive
integer in the inclusive range 1–1,000. The upper bound is the shared adapter constraint
`MEDIA_IDENTITY_MAX_PAGE_SIZE = 1_000`
(`packages/rfmedia-cli/src/types/media-server.ts:29`) enforced when the common configured value
reaches identity composition (`packages/rfmedia-cli/src/lib/adapters/plex/identity.ts:54-61`).
The existing adapter fixture's `pageSize: 250`
(`packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts:60-75`) confirms values above 100 are
valid.

## API/Validation Contract

- Absent or explicitly `undefined` fields remain absent.
- `plex.pageSize` accepts only integer values from 1 through 1,000, inclusive. Reject `0`,
  negatives, fractions, strings, and values above 1,000 with `ConfigError.propertyPath ===
"plex.pageSize"`. Reuse `validateBoundedInteger` and the exported media identity maximum; do not
  reuse the interactive 5–100 validator or duplicate `1_000`.
- `plex.syncRatingsOnCopy` accepts only booleans through `validateBoolean`.
- `plex.syncOnCopyDefaults` must be a non-null, non-array object.
- `plex.syncOnCopyDefaults.popmEmail`, when present, is a non-empty string through
  `validateString`.
- `plex.syncOnCopyDefaults.vorbisScale`, when present, is exactly `"normalized"`, `"stars"`, or
  `"percent"`. Reuse `VALID_VORBIS_SCALE_VALUES` (`config.ts:931-936`).
- An empty `syncOnCopyDefaults: {}` is valid and introduces no defaults.
- Preserve the established Plex policy that unknown nested keys are ignored, documented at
  `config.ts:1144-1150`; changing unknown-key behavior is outside this fix.
- All failures are `ConfigError`s carrying the exact nested property path.

Add `validatePlexSyncOnCopyDefaults` beside `validatePlexSyncDefaults`
(`config.ts:938-999`), then add all three branches to `validatePlexConfigOptions` before its return
at `config.ts:1352`.

For compile-time drift detection, mirror the `CopyOptions` pattern at
`packages/rfmedia-cli/src/lib/plan.ts:881-894`: define the union of keys handled by
`validatePlexConfigOptions`, compute
`Exclude<keyof PlexConfigOptions, ValidatedPlexConfigOptionKeys>`, and assign `true` through a
conditional `never` fence. Keep it adjacent to the validator so a future top-level
`PlexConfigOptions` addition fails typecheck until classified and validated.

## System Constraints

- The change activates already-documented behavior for users whose values were previously dropped;
  call it a fix and include an Unreleased changelog entry.
- `pageSize` is shared across four adapter capability families. The 1,000 ceiling is the strictest
  downstream contract and prevents adapter construction from failing later with a `RangeError`.
- Config validation is allowlist-by-copy and intentionally does not preserve arbitrary input keys.
- Do not add runtime defaults during validation; omission is observable and existing consumer
  fallback order is load-bearing.
- No CLI commands or flags change, so Bash, Zsh, Fish, and completion parity tests require no edits.
- `buildConfigTemplate` (`config.ts:4590-4706`) is a plain object serialized by `yaml.dump`; package
  guidance at `packages/rfmedia-cli/AGENTS.md:1050-1052` directs documentation updates instead of
  adding uncommentable optional blocks. No config-template or init-merge change is required.
- `plex-adapter.test.ts` injects typed config directly through a mocked loader and therefore cannot
  prove production validation. Keep it as downstream regression coverage; put the new contract
  tests in `config.test.ts`.

## Codebase Changes

1. `packages/rfmedia-cli/src/lib/config.ts:29-80,931-1353`
   - Import `PlexSyncOnCopyDefaults` and the shared 1,000 maximum.
   - Add the nested sync-on-copy validator, the three top-level branches, and the exhaustiveness
     fence.
2. `packages/rfmedia-cli/src/lib/config.test.ts:1-15,1292+`
   - Add one round-trip case containing all three accepted values.
   - Add a compact rejection table covering page-size type/lower/upper failures, non-boolean sync,
     non-object defaults, empty `popmEmail`, and invalid `vorbisScale`.
   - Assert `ConfigError.propertyPath`, not only that an error was thrown.
3. `packages/rfmedia-cli/README.md:4834-4890,4948-4959`
   - Add all three options to the config example/reference and state the 1–1,000 Plex page bound.
4. `packages/rfmedia-cli/docs/features/plex-configuration.md:45-115,117-191`
   - Add `pageSize` and its bounds. Existing sync-on-copy text becomes truthful after this fix;
     retain its precedence/default documentation.
5. `packages/rfmedia-cli/CHANGELOG.md:8-18`
   - Add a `### Fixed` bullet noting that the three configured Plex values now survive validation
     and invalid values fail early.
6. `ROADMAP.md:8-10,34-59,151-165` and `docs/roadmap-archive.md:10-32`
   - At closeout, refresh live issue totals, remove #289 from both open lists, adjust the post-JWT
     focus while #288 remains open, and archive #289 with the actual closing PR.
7. `docs/internal/plex-jwt-deferrals.md:8,157-163,185-186`
   - Mark #289 resolved/link the closing PR while retaining #288 as an open follow-up.
8. Separate GitHub issue
   - File the audited `CopyConfigOptions.conflictStrategy` silent-drop defect; do not fix it in #289.

## Technical Decisions

- **Bound is 1–1,000:** this preserves the valid 250 fixture and fails at config load before the
  stricter identity capability would reject an oversized shared value.
- **Reuse one enum tuple:** sync defaults and sync-on-copy defaults expose the same Vorbis union, so
  two independently maintained value lists would create drift.
- **Fence only `PlexConfigOptions`:** this exactly meets #289. A generalized validator framework or
  repo-wide fence refactor would enlarge the maintenance change.
- **Boundary tests are sufficient:** consumer code and playlist config-default behavior already have
  coverage (`plex-playlist.test.ts:1489-1523`); duplicating action tests does not prove the dropped
  production boundary.
- **Do not fix the audit finding here:** the live issue explicitly scopes additional discoveries to
  separately filed issues.

## Audit Method

The audit compared every property declared by `ConfigFile` and its option interfaces in
`packages/rfmedia-cli/src/types/config.ts:23-564` with the raw-key accesses, constant key sets, and
returned shapes of validators in `packages/rfmedia-cli/src/lib/config.ts:629-4434`. Dynamic filter
records and Lidarr preset packs were checked against their dedicated recursive validators rather
than treated as fixed option objects.

All top-level config sections and nested option shapes have matching validation paths except:

| Interface           | Missing validator key                                 | Disposition         |
| ------------------- | ----------------------------------------------------- | ------------------- |
| `PlexConfigOptions` | `pageSize`, `syncRatingsOnCopy`, `syncOnCopyDefaults` | Fix in #289         |
| `CopyConfigOptions` | `conflictStrategy`                                    | File separate issue |

No existing issue matched `conflictStrategy` plus config validation in the live repository search.

Focused validation, from `packages/rfmedia-cli`:

```bash
npm run typecheck
env -u FORCE_COLOR npx vitest run src/lib/config.test.ts
env -u FORCE_COLOR npx vitest run src/lib/adapters/plex-adapter.test.ts
env -u FORCE_COLOR npx vitest run src/actions/plex-playlist.test.ts
```

Full validation:

```bash
env -u FORCE_COLOR npm run test:run
npm run lint:md --workspace-root
```

Before merge, rerun live issue counts rather than assuming the observed 79 total / 43 rfmedia /
36 rfapps snapshot. Verify #289 closes, the separate audit issue exists, and the ROADMAP/archive
numbers and links match GitHub.

## Open Questions

- What number will GitHub assign to the `CopyConfigOptions.conflictStrategy` follow-up and to the
  closing PR? Use those live identifiers in ROADMAP/archive documentation.
- If #288 merges first, recalculate and rewrite the post-JWT roadmap section from live state instead
  of applying the #289-only counter delta.
