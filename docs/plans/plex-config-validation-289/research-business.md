# Plex Configuration Validation Business Research

## Executive Summary

GitHub issue [#289](https://github.com/yandy-r/rfmedia-apps/issues/289) fixes three declared
`PlexConfigOptions` fields that `validatePlexConfigOptions` silently drops: `pageSize`,
`syncRatingsOnCopy`, and `syncOnCopyDefaults`. The fix must validate and preserve them and add a
compile-time fence that turns future top-level declaration/validator drift into a type-check failure.

This changes upgrade behavior: existing valid values become effective for the first time, while
invalid values that were ignored now fail validation. The wider audit found one analogous non-Plex
gap, `CopyConfigOptions.conflictStrategy`; no existing issue was found, so it must be filed and fixed
separately.

## User Stories

- As an operator, I want configured Plex page size and copy-time rating settings to affect the
  production path, with explicit CLI values retaining precedence.
- As an upgrading user, I want warning that previously inert settings can now change API batching or
  cause destination metadata writes.
- As a maintainer, I want a new unclassified `PlexConfigOptions` key to fail type checking.
- As an auditor, I want unrelated dropped fields tracked separately so #289 stays small.

## Business Rules

| Field                     | Accepted                                                                                                                                            | Rejected                                                              | Omitted                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `plex.pageSize`           | Integer `1`–`1_000`, inclusive; `250` is valid.                                                                                                     | Non-number, fraction, zero, negative, or `>1_000`; no coercion.       | Existing consumer defaults, normally `100`.     |
| `plex.syncRatingsOnCopy`  | Literal `true` or `false`; false is not absence.                                                                                                    | String, number, object, array, or `null`.                             | `false`.                                        |
| `plex.syncOnCopyDefaults` | Non-null, non-array object; optional non-empty string `popmEmail`; optional `vorbisScale` of `"normalized"`, `"stars"`, `"percent"`; `{}` is valid. | Wrong outer shape, blank/non-string email, or scale outside the enum. | `"no@email"` and `"normalized"` at consumption. |

- `1_000` is the strictest shared Plex consumer bound (`MEDIA_IDENTITY_MAX_PAGE_SIZE`); the same
  setting feeds query, identity, playlist, and collection capabilities. Do not reuse the unrelated
  interactive UI helper, whose `5`–`100` contract would reject the existing `250` fixture.
- Validation preserves supplied values but does not write consumer defaults into resolved config.
- CLI `--no-sync-ratings`, `--popm-email`, and `--vorbis-scale` continue to override config.
- Existing Plex validators ignore unknown raw keys. #289 fences declared top-level fields; it does
  not add general typo rejection or strict unknown-key handling.
- A valid configured `pageSize` now changes batching and request count. Configured
  `syncRatingsOnCopy: true` now writes positive Plex ratings to supported destination metadata;
  hardlinks can modify the source inode, for which the action already warns.
- Invalid values make `validateConfig` throw `ConfigError` with a precise property path. The
  higher-level `loadConfig` currently catches this, warns, and tries another path/defaults; changing
  that loader-wide policy is outside #289.
- The changelog must present this as a behavior-changing fix, not a neutral chore.
- The fence covers every `keyof PlexConfigOptions`, including `auth`, but is not runtime validation
  and does not automatically cover future nested-interface fields.
- A static audit of interfaces in `src/types/config.ts` against `src/lib/config.ts` found only one
  additional zero-reference declaration: `CopyConfigOptions.conflictStrategy`. A live issue search
  on 2026-07-30 returned no match; #289 requires a separate follow-up issue, not an in-scope fix.

## Workflows

### Primary

1. The CLI parses YAML/JSON and delegates `plex` to `validatePlexConfigOptions`.
2. The three fields are validated without coercion and copied into resolved config.
3. `setLoadedConfig` exposes them to actions and adapter factories.
4. `pageSize` reaches Plex query/identity/playlist/collection paging; sync settings become defaults
   for Plex copy and playlist export.
5. Present CLI values override sync configuration.

### Error and upgrade

1. An invalid present field throws `ConfigError`; `propertyPath` names the top-level or nested key.
2. The invalid value never reaches an adapter/action. File loading retains its existing
   warn-and-search/fallback behavior.
3. Before upgrading, users should correct invalid values and confirm `syncRatingsOnCopy: true` is
   intended, especially with hardlinks. Omission needs no migration and preserves old defaults.

## Domain Model

- **Declared config:** `PlexConfigOptions`, the supported top-level schema.
- **Raw config:** untrusted YAML/JSON whose runtime shape cannot be inferred from TypeScript.
- **Resolved config:** validated values stored by `setLoadedConfig`; a missing assignment makes a
  declared option inert.
- **Consumer default:** applied only when the resolved option is absent (`100`, `false`,
  `"no@email"`, or `"normalized"` as applicable).
- **Exhaustiveness fence:** type-level comparison of `keyof PlexConfigOptions` with classified
  validator keys; it prevents drift but performs no runtime validation.
- **Copy-time rating sync:** opt-in transfer of positive Plex ratings to supported destination file
  metadata, with CLI flags as final authority.

## Existing Codebase Integration

- `packages/rfmedia-cli/src/types/config.ts`: source interfaces and nested sync-default contract.
- `packages/rfmedia-cli/src/lib/config.ts`: validation, silent-drop site, `ConfigError`, and loader
  fallback.
- `packages/rfmedia-cli/src/lib/plan.ts`: precedent for the compile-time allowlist fence.
- `packages/rfmedia-cli/src/lib/adapters/index.ts` and `src/lib/adapters/plex-adapter.ts`: transfer
  `pageSize` to all four adapter capabilities.
- `packages/rfmedia-cli/src/types/media-server.ts`: shared `1_000` identity limit.
- `packages/rfmedia-cli/src/actions/plex-copy.ts` and `src/actions/plex-playlist.ts`: existing
  config-below-CLI precedence and rating-write behavior.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts`: typed `pageSize: 250` mock bypasses
  production validation and masks the bug.
- `packages/rfmedia-cli/src/lib/config.test.ts`: correct contract-test boundary.
- Plex configuration/metadata-sync docs, `rfmedia.example.yaml`, and the package changelog must state
  effective behavior, bounds, and upgrade risk.
- `ROADMAP.md` lists #289 in “Next Up” and the medium backlog. Remove both rows when done; do not
  archive the whole post-JWT sprint while #288 remains open.

## Success Criteria

- `pageSize: 250`, `syncRatingsOnCopy: true`, and
  `syncOnCopyDefaults: { popmEmail: "user@example.com", vorbisScale: "stars" }` round-trip unchanged.
- Page sizes `1` and `1_000` are valid; `0`, `1_001`, fractions, and non-numbers cannot reach a
  consumer.
- Both booleans survive; invalid sync values fail at the correct property path.
- Nested shape and both child contracts are validated; omission preserves current defaults.
- CLI sync/metadata flags retain precedence.
- Focused config coverage has one accepted and one representative rejected case per top-level field;
  a combined acceptance case and small rejection table are sufficient.
- Typecheck passes now and fails in a compile-only probe with an added unclassified Plex key.
- A separate issue is filed for `copy.conflictStrategy`; no non-Plex source change lands in #289.
- Changelog/docs explain activation on upgrade, and `ROADMAP.md` no longer lists completed #289.

## Open Questions

- What follow-up issue number will own the confirmed `CopyConfigOptions.conflictStrategy` gap?
- Should `loadConfig` eventually fail closed instead of warning and falling back after any
  `ConfigError`? This is cross-cutting follow-up work, not a blocker for #289.
- Should Plex validators eventually reject unknown keys? That compatibility decision is separate
  from closing declared-field drift.
