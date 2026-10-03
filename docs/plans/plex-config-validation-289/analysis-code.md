# Code Analysis: Plex Config Validation (#289)

## Executive Summary

`PlexConfigOptions` declares three fields that `validatePlexConfigOptions` never copies into the
validated object: `pageSize`, `syncRatingsOnCopy`, and `syncOnCopyDefaults`. The repair is localized
to `packages/rfmedia-cli/src/lib/config.ts`: reuse existing scalar/range validators, add one small
nested-object validator, assign the three fields only when present, and add a compile-time
top-level key-coverage fence. Existing adapter/action consumers already implement the required
defaults and CLI precedence, so they should remain unchanged.

## Existing Code Structure

- `packages/rfmedia-cli/src/types/config.ts:228-237` defines
  `PlexSyncOnCopyDefaults` with optional `popmEmail` and the exact
  `normalized | stars | percent` union.
- `packages/rfmedia-cli/src/types/config.ts:271-306` is the source-of-truth
  `PlexConfigOptions` interface. The dropped fields are at lines 288-303; all 15 top-level keys are
  optional.
- `packages/rfmedia-cli/src/types/media-server.ts:28-29` defines the shared
  `MEDIA_IDENTITY_MAX_PAGE_SIZE = 1_000` ceiling.
- `packages/rfmedia-cli/src/lib/config.ts:274-283` validates booleans without coercion,
  preserving explicit `false`.
- `packages/rfmedia-cli/src/lib/config.ts:345-360` provides inclusive integer-range validation;
  `packages/rfmedia-cli/src/lib/config.ts:365-374` provides non-empty string validation.
- `packages/rfmedia-cli/src/lib/config.ts:928-999` defines
  `VALID_VORBIS_SCALE_VALUES` and validates the structurally similar `PlexSyncDefaults`.
- `packages/rfmedia-cli/src/lib/config.ts:1200-1353` builds a fresh `PlexConfigOptions` and
  explicitly assigns every recognized Plex key except the three issue fields.
- `packages/rfmedia-cli/src/lib/config.ts:4297-4305` is the public `validateConfig` boundary:
  it rejects a non-object top-level `plex` section and delegates to `validatePlexConfigOptions`.
- `packages/rfmedia-cli/src/lib/loaded-config.ts:20-53` stores the validated `ConfigFile` and
  exposes `getLoadedPlexConfig()` with an empty-object fallback.
- `packages/rfmedia-cli/src/lib/config.test.ts:1-15,58-75` establishes that private validators are
  tested through public `validateConfig`; mocks must be cleared, not reset.

## Implementation Patterns

- **Presence-preserving assignments:** Plex validators use
  `"key" in raw && raw["key"] !== undefined` before validation and assignment
  (`config.ts:1208-1226`). Follow this exactly so omission stays omission and `false` is retained.
- **Nested object gate:** Existing Plex blocks reject `null`, arrays, and non-objects before casting
  to `Record<string, unknown>` (`config.ts:1242-1260`, `1302-1327`). Apply the same gate to
  `syncOnCopyDefaults`.
- **Dedicated nested validator:** Place `validatePlexSyncOnCopyDefaults` immediately before
  `validatePlexConfigOptions`, matching the neighboring helpers. It should start with `{}`, validate
  only present `popmEmail` and `vorbisScale`, and return no materialized defaults.
- **Enum validation:** Reuse `VALID_VORBIS_SCALE_VALUES` and the cast/includes/typed-assignment
  pattern at `config.ts:983-996`; only the property path and message prefix change.
- **Compile-time drift fence:** `packages/rfmedia-cli/src/lib/plan.ts:881-894` classifies keys with
  `Exclude<keyof ..., ...>` and assigns `true` to a conditional-`never` constant, then voids it.
  Mirror that locally for all handled `PlexConfigOptions` keys after the validator.
- **Compact boundary tests:** `config.test.ts:2282-2301` uses parameterized accepted/rejected
  values and asserts `ConfigError.propertyPath`; `config.test.ts:2304-2323` compactly checks invalid
  object shapes; `config.test.ts:2165-2193` proves complete round-trip plus empty-object semantics.

## Integration Points

- `packages/rfmedia-cli/src/lib/adapters/index.ts:220-273` merges CLI connection overrides with
  loaded Plex config and forwards `loadedConfig.pageSize` unchanged.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts:283-315` supplies that page size to query,
  identity, playlist, and collection capability families.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts:60-73` already has focused adapter
  fixtures with `pageSize: 250`; retain this as downstream regression evidence.
- `packages/rfmedia-cli/src/actions/plex-copy.ts:223-248` applies action options first, then
  `syncRatingsOnCopy ?? false`, `popmEmail ?? "no@email"`, and
  `vorbisScale ?? "normalized"`.
- `packages/rfmedia-cli/src/actions/plex-playlist.ts:296-328` uses the same precedence/default
  contract for playlist export; lines 337-340 preserve the hardlink mutation warning.
- `packages/rfmedia-cli/docs/features/plex-configuration.md:185-191` already documents CLI override
  precedence and rating-sync defaults; add the validated `pageSize` range and upgrade activation
  warning without rewriting the workflow.
- Completion sources are `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` with
  parity coverage in `templates.spec.ts`. Audit them, but do not modify them because no command or
  flag changes.

### Files to Modify

- `packages/rfmedia-cli/src/lib/config.ts`: imports, nested validator, three assignments, fence.
- `packages/rfmedia-cli/src/lib/config.test.ts`: one combined acceptance test and compact invalid
  cases with exact paths.
- `packages/rfmedia-cli/docs/features/plex-configuration.md`: range and existing-config activation.
- `packages/rfmedia-cli/CHANGELOG.md`: Unreleased behavior-changing fix note.
- `ROADMAP.md:56,165`: remove completed #289 and reconcile live totals.
- `docs/roadmap-archive.md`: archive #289 with its closing PR.
- `docs/internal/plex-jwt-deferrals.md:158-160,186`: mark the #289 deferral resolved.

### Files to Create

- None. Do not add a schema, utility, fixture, or new test file.

## Code Conventions

- Keep TypeScript strict and ESM imports suffixed with `.js`.
- Add `PlexSyncOnCopyDefaults` to the existing type-only import; import
  `MEDIA_IDENTITY_MAX_PAGE_SIZE` as a runtime value, preferably directly from
  `../types/media-server.js`.
- Preserve the mutable validated-object pattern documented at
  `types/config.ts:250-255`; do not refactor the validator into spreading raw input.
- Error paths must be exactly `plex.pageSize`, `plex.syncRatingsOnCopy`,
  `plex.syncOnCopyDefaults`, `plex.syncOnCopyDefaults.popmEmail`, and
  `plex.syncOnCopyDefaults.vorbisScale`.
- Preserve unknown-key behavior: top-level and nested Plex validators currently ignore unknown
  keys. The compile-time fence classifies source-interface keys; it is not runtime strictness.
- Format markdown with blank lines around headings and keep Prettier-compatible wrapping.

## Dependencies and Services

- No package, database, migration, Docker, Plex API, or generated-client change is required.
- Runtime implementation depends only on existing `ConfigError`, scalar validators,
  `VALID_VORBIS_SCALE_VALUES`, and `MEDIA_IDENTITY_MAX_PAGE_SIZE`.
- Vitest is the only test dependency. TypeScript typecheck is the proof for the compile-time fence;
  a runtime test cannot prove that invariant.
- Build `@rfmedia/common` before package checks in a fresh worktree, then use the existing
  `rfmedia-cli` typecheck/test scripts.

## Gotchas and Warnings

- Do not use truthiness checks for `syncRatingsOnCopy`; they would silently erase explicit `false`.
- Do not apply `??` defaults in validation. Consumers at `plex-copy.ts:245-247` and
  `plex-playlist.ts:325-327` deliberately own runtime defaults.
- `pageSize` must use the 1-1,000 shared ceiling, not the unrelated interactive page-size bounds
  handled by `validatePageSize` at `config.ts:285-308`.
- `Number.isInteger` is the repository validator convention. Do not accept numeric strings,
  fractions, `NaN`, or infinities.
- `{}` is valid for `syncOnCopyDefaults`; `null`, arrays, strings, and numbers are not.
- `validateString` rejects whitespace-only values but returns the original non-empty string; do not
  add email-format, byte-length, NUL, or trimming semantics.
- A config with `syncRatingsOnCopy: true` starts causing rating metadata writes after this fix.
  With hardlinks, destination writes affect the shared source inode; release notes must call this
  out.
- `loadConfig` fallback/error behavior is intentionally sensitive
  (`config.test.ts:2195-2198`); do not change loader policy while repairing validation.
- Child issue #302 owns `CopyConfigOptions.conflictStrategy`; exclude it from this branch.

## Task-Specific Guidance

1. In `config.ts`, import the nested type and shared maximum.
2. Add `validatePlexSyncOnCopyDefaults(raw, configPath)` near the existing Plex nested validators.
   Validate `popmEmail` with `validateString`; validate `vorbisScale` against the existing constant.
3. In `validatePlexConfigOptions`, assign:
   - `pageSize` through `validateBoundedInteger(value, 1, MEDIA_IDENTITY_MAX_PAGE_SIZE, ...)`;
   - `syncRatingsOnCopy` through `validateBoolean`;
   - `syncOnCopyDefaults` after the standard non-null/non-array object gate.
4. Add a handled-key union covering all 15 current `PlexConfigOptions` keys, compute
   `Exclude<keyof PlexConfigOptions, HandledPlexConfigKey>`, and use the plan-style
   conditional-`never` constant. A newly added top-level field must fail typecheck until classified.
5. In `config.test.ts`, add one combined success case proving `pageSize`, explicit `false`, both
   nested values, and `{}` retention. Add one compact invalid table covering page-size type,
   fraction, lower/upper bounds; non-boolean sync; invalid outer shape; empty/wrong-type
   `popmEmail`; and invalid `vorbisScale`. Assert both `ConfigError` and exact `propertyPath`.
6. Run focused config and adapter tests, full package tests, package typecheck, repository build,
   lint/markdown/format checks, and `git diff --check`. Record completion-template audit as
   “no change required.”
