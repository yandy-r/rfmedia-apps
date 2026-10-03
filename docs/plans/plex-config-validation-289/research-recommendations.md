# Recommendations: Plex Configuration Validation (#289)

## Executive Summary

Fix the defect at the existing config trust boundary: validate and retain
`plex.pageSize`, `plex.syncRatingsOnCopy`, and `plex.syncOnCopyDefaults` in
`validatePlexConfigOptions`, then add a `keyof PlexConfigOptions` exhaustiveness fence. Keep the
change narrow: TypeScript and Vitest are sufficient, downstream precedence/default behavior must
not change, and the separately tracked `copy.conflictStrategy` gap belongs to child issue #302.

## Resolved Research Conflicts

- **Plex page-size range is 1–1,000 inclusive.** Use
  `MEDIA_IDENTITY_MAX_PAGE_SIZE` rather than the interactive `validatePageSize` range of 5–100.
  `pageSize: 250` is already a valid adapter fixture, and the same config value feeds the query,
  identity, playlist, and collection capabilities.
- **Preserve the established nested-validator policy.** Require the correct object and leaf
  shapes, but continue ignoring unknown nested keys. Do not add unknown-key rejection, NUL checks,
  byte limits, or email-format validation solely for `syncOnCopyDefaults`.
- **The wider audit is complete for #289.** `CopyConfigOptions.conflictStrategy` is tracked by
  child issue #302; do not change non-Plex validation in this work.
- **No shell-completion edits are required.** The change adds no commands or options, so Bash,
  Zsh, Fish, and their parity tests remain unchanged.

## Key Decisions

1. Validate at `validatePlexConfigOptions`; do not defer validation to adapters or actions.
2. Preserve explicit values and preserve omission. Do not materialize consumer defaults in the
   resolved config.
3. Reuse `validateBoundedInteger`, `validateBoolean`, `validateString`,
   `VALID_VORBIS_SCALE_VALUES`, and `MEDIA_IDENTITY_MAX_PAGE_SIZE`.
4. Add a dedicated `validatePlexSyncOnCopyDefaults` beside `validatePlexSyncDefaults`; the latter
   accepts unrelated fields and should not be reused wholesale.
5. Keep the top-level exhaustiveness fence adjacent to `validatePlexConfigOptions` and classify
   every `keyof PlexConfigOptions`, including `auth` and the three restored fields.
6. Put new runtime contract tests in `src/lib/config.test.ts`; typed adapter mocks are useful
   downstream tests but cannot prove YAML/config persistence.
7. Preserve CLI-over-config precedence and existing consumption defaults:
   `false`, `"no@email"`, and `"normalized"`.

## Validation Contract

| Property                  | Accepted                                               | Rejected/path                                                   |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| `plex.pageSize`           | Integer `1..MEDIA_IDENTITY_MAX_PAGE_SIZE` (`1..1_000`) | Non-number, fraction, `<1`, or `>1_000`; `plex.pageSize`        |
| `plex.syncRatingsOnCopy`  | Literal boolean, including `false`                     | Any non-boolean; `plex.syncRatingsOnCopy`                       |
| `plex.syncOnCopyDefaults` | Non-null, non-array object; `{}` is valid              | Primitive, `null`, or array; `plex.syncOnCopyDefaults`          |
| `.popmEmail`              | Present non-empty string                               | Wrong type or empty string; `plex.syncOnCopyDefaults.popmEmail` |
| `.vorbisScale`            | `"normalized"`, `"stars"`, or `"percent"`              | Any other value; `plex.syncOnCopyDefaults.vorbisScale`          |

Absent or explicitly `undefined` values remain absent. Validation returns a fresh allowlisted
object and never spreads raw config input.

## Implementation Recommendations

### Runtime validation

- Import `PlexSyncOnCopyDefaults` and `MEDIA_IDENTITY_MAX_PAGE_SIZE`.
- Add `validatePlexSyncOnCopyDefaults(raw, configPath)` using the same object guard, optional-field
  checks, error wording, and dotted-path handling as neighboring Plex validators.
- Add three guarded assignments to `validatePlexConfigOptions`:
  - `pageSize` through `validateBoundedInteger(..., 1, MEDIA_IDENTITY_MAX_PAGE_SIZE, ...)`;
  - `syncRatingsOnCopy` through `validateBoolean`;
  - `syncOnCopyDefaults` through the dedicated nested validator.
- Keep field-presence handling consistent with existing branches so explicit `false` survives.

### Compile-time fence

- Define a handled-key union or literal tuple constrained to `keyof PlexConfigOptions`.
- Compute missing keys with `Exclude<keyof PlexConfigOptions, HandledPlexConfigKey>`.
- Assign the conditional result to a `true` constant so a future unclassified top-level field
  becomes a type-check error.
- Do not use a broad cast, index signature, or raw object spread that defeats the fence.

### Tests

- Add one combined round-trip test through `validateConfig` containing `pageSize: 250`,
  `syncRatingsOnCopy: true`, and both nested defaults.
- Add compact parameterized coverage for page-size boundaries (`1`, `1_000`) and representative
  failures (`0`, `1_001`, a fraction, and a non-number).
- Add representative failures for non-boolean rating sync, invalid nested outer shape, empty
  `popmEmail`, and invalid `vorbisScale`; assert `ConfigError.propertyPath`.
- Let `npm run typecheck` enforce the fence. A committed runtime test for a type-only invariant is
  unnecessary.
- Do not add completion-template tests: no Bash, Zsh, Fish, command, or option surface changes.

### Documentation

- Add an Unreleased fix note explaining that previously ignored settings now take effect.
- Minimally update the canonical Plex configuration reference to state the 1–1,000 `pageSize`
  range and the upgrade activation risk for rating writes, especially with hardlinks.
- Update `ROADMAP.md` narrowly for #289 using current issue state; avoid unrelated archival or
  counter churn.
- Avoid unrelated cleanup of older rating-sync examples or duplicated reference prose.

## Technology Choices

- Use the current TypeScript validator utilities and compile-time type system.
- Use the existing Vitest suite and `ConfigError` contract.
- Add no schema library, Plex SDK, validation package, or lockfile change.
- Share the existing maximum and Vorbis enum rather than defining parallel constants.

## Delivery Phases and Task Breakdown

1. **Boundary repair**
   - Add the nested validator and three persistence branches in `src/lib/config.ts`.
   - Add the adjacent top-level exhaustiveness fence.
2. **Contract proof**
   - Add the combined success case and compact rejection table in `src/lib/config.test.ts`.
   - Verify exact property paths and preservation of explicit `false` if not covered by the
     combined case.
3. **Minimal user communication**
   - Add the behavior-changing fix note and focused Plex config-reference update.
   - Update the #289 ROADMAP entry only; avoid unrelated archive/internal-document cleanup.
4. **Verification**
   - Run `npm run typecheck`.
   - Run `env -u FORCE_COLOR npx vitest run src/lib/config.test.ts`.
   - Run existing Plex adapter/playlist regressions only if the implementation touches shared
     behavior; otherwise rely on the full package suite before merge.
   - Run `env -u FORCE_COLOR npm run test:run` and the repository Markdown lint.

## Quick Wins

- A single combined success fixture proves all three formerly dropped values survive the real
  boundary.
- Reusing the shared 1,000 maximum prevents config/adapter contract drift immediately.
- The local `keyof` fence prevents another top-level Plex option from silently disappearing.
- Linking #302 satisfies the audit disposition without enlarging the #289 diff.

## Risk Assessment

| Risk                                                                                         | Level  | Mitigation                                                                                |
| -------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| Existing `syncRatingsOnCopy: true` begins metadata writes; hardlinks can affect source files | High   | Preserve opt-in/CLI precedence and hardlink warning; call out activation in release notes |
| Large pages increase Plex response work across four capabilities                             | Medium | Reject values outside `1..1_000` at config load                                           |
| Invalid high-priority config may warn and fall through to another file/defaults              | Medium | Preserve current loader policy; track fail-closed behavior separately                     |
| Fence covers top-level keys, not future nested-interface fields                              | Low    | Keep explicit nested validator; consider broader nested fences only as separate work      |
| Over-broad strictness breaks previously tolerated configs                                    | Medium | Match current unknown-key and string-validation policy                                    |

## Alternatives Rejected

- **Reuse interactive `validatePageSize`:** rejects valid Plex values above 100.
- **Spread raw fields into the result:** bypasses validation and the sanitizing allowlist.
- **Add Zod/AJV or a generic handler framework:** disproportionate for three fields and creates a
  second config-validation model.
- **Reject unknown keys or add NUL/byte/email constraints:** inconsistent with neighboring nested
  validators and outside issue scope.
- **Apply defaults during validation:** changes omission semantics and duplicates consumer policy.
- **Fix `copy.conflictStrategy` here:** violates the requested Plex-only scope; issue #302 owns it.

## Open Questions

- Which single canonical config reference should receive the focused documentation update if the
  README and feature guide duplicate the same material?
- Should a separate follow-up tighten `loadConfig` so malformed selected config cannot silently
  fall through to another path/defaults?
- Is a repo-wide rollout of top-level validator fences desirable after #289 and #302 demonstrate
  the pattern? This is not a blocker for #289.
