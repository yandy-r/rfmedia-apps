# Engineering Practices Research: Plex Config Validation

## Executive Summary

`validatePlexConfigOptions` is an explicit copy-and-validate allowlist, but it omits
`pageSize`, `syncRatingsOnCopy`, and `syncOnCopyDefaults`; downstream tests that inject a typed
`PlexConfigOptions` directly therefore cannot prove the production load path. The smallest durable
fix is to reuse existing scalar validators and enum constants, add one focused nested validator,
and mirror the compile-time allowlist fence already used in `src/lib/plan.ts`.

A static interface-to-validator audit found the root `ConfigFile` and the other mapped config
interfaces covered, except for a separate candidate: `CopyConfigOptions.conflictStrategy` is not
referenced by `validateCopyConfig`. Per issue scope, confirm and file that separately rather than
expanding #289.

## Existing Reusable Code

| Code                                                 | Reuse                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/lib/config.ts:274` `validateBoolean`            | Validate and preserve `syncRatingsOnCopy`.                                                |
| `src/lib/config.ts:294` `validatePageSize`           | Reuse if Plex adopts the existing inclusive 5-100 page-size contract.                     |
| `src/lib/config.ts:345` `validateBoundedInteger`     | Use with explicit Plex bounds if its paging contract differs from interactive UI paging.  |
| `src/lib/config.ts:946` `validatePlexSyncDefaults`   | Pattern for nested POPM email and Vorbis scale validation.                                |
| `src/lib/config.ts:936` `VALID_VORBIS_SCALE_VALUES`  | Share the enum source with `syncOnCopyDefaults.vorbisScale`.                              |
| `src/lib/config.ts:1202` `validatePlexConfigOptions` | Keep validation and persistence at the existing config trust boundary.                    |
| `src/lib/plan.ts:881` drift fence                    | Mirror `Exclude<keyof Source, ClassifiedKeys>` plus a `never` assertion.                  |
| `src/lib/config.test.ts:2165` Plex auth tests        | Prefer one round-trip case plus compact invalid-value tables.                             |
| `src/lib/shell-completions/templates.spec.ts`        | Existing Bash/Zsh/Fish parity boundary; audit only because this change adds no CLI flags. |

## Modularity

- Add `validatePlexSyncOnCopyDefaults` beside `validatePlexSyncDefaults`; keep object-shape checking
  in `validatePlexConfigOptions`, matching the other Plex nested sections.
- Do not move general config validation into the Plex adapter. The loader owns untrusted YAML/JSON;
  the adapter should continue receiving typed, validated values.
- Keep the exhaustiveness key classification adjacent to `validatePlexConfigOptions` so a future
  interface edit and its required validator edit are reviewed together.
- Do not modify `plex-adapter.test.ts` merely to route it through the loader; its direct typed mocks
  remain useful unit tests, while `config.test.ts` owns persistence through the real boundary.

## KISS

- Add three branches and one two-field nested validator; avoid a schema framework or generic
  reflective validator for this localized defect.
- Apply defaults only at existing consumption sites. Validation should preserve explicit values and
  omitted keys, not materialize `false`, email, scale, or page-size defaults.
- Reuse the existing Vorbis enum and string/boolean validators rather than duplicating checks.
- Decide the Plex page-size bounds explicitly. Do not reuse the 5-100 helper solely because its name
  is generic if Plex pagination permits a different range.

## Abstraction vs Repetition

- The repeated nested-object guard is an established, readable pattern in this file; one more use is
  preferable to introducing a helper with callbacks for a single two-field block.
- The allowlist fence is valuable abstraction because it converts interface drift into a compiler
  error. A key tuple constrained with `satisfies readonly (keyof PlexConfigOptions)[]`, plus
  `Exclude<keyof PlexConfigOptions, (typeof keys)[number]> extends never`, checks both invalid and
  missing keys.
- Avoid a handler map unless more validators adopt it: heterogeneous validation and property-path
  errors would make the map harder to read than explicit branches.

## Interface Design

- `PlexConfigOptions` remains the source of truth; no public interface change is required.
- Return a fresh `PlexConfigOptions`, preserving the current sanitizing allowlist and unknown-key
  behavior.
- The fence should classify every top-level Plex key, including `auth` and all three restored keys,
  while runtime branches remain explicit.
- `syncOnCopyDefaults` must reject null, arrays, and primitives at `plex.syncOnCopyDefaults`, then
  validate `popmEmail` as a string and `vorbisScale` against the shared three-value enum with exact
  property paths.
- Treat already-configured values becoming effective as a behavior fix and document the side-effect
  risk for rating synchronization.

## Testability

Critical new coverage should stay in `src/lib/config.test.ts`:

1. One combined round-trip test passes valid `pageSize`, `syncRatingsOnCopy`, and both nested
   defaults through `validateConfig` and deep-compares the retained Plex object.
2. One compact rejection table covers: out-of-range/non-integer `pageSize`, non-boolean
   `syncRatingsOnCopy`, non-object `syncOnCopyDefaults`, non-string `popmEmail`, and invalid
   `vorbisScale`; assert `ConfigError.propertyPath`.
3. `npm run typecheck` is the test for the compile-time fence; do not add a runtime test for a type
   invariant.

Run the targeted config test and typecheck first, then the package suite. Existing adapter tests
should be run as regression evidence, but need no new cases unless production consumption changes.

Completion-template audit: record that `bash.ts`, `zsh.ts`, `fish.ts`, and
`templates.spec.ts` were reviewed and require no changes because this is config-only and adds no
command or option. Do not add artificial completion assertions.

## Build vs Depend

Use TypeScript, Vitest, and current local utilities only. A validation dependency would add bundle,
upgrade, and schema-migration cost without improving this five-value boundary. The existing
`typecheck` script already enforces the proposed fence, and the existing test runner covers the
runtime contract.

## Open Questions

- Is `plex.pageSize` intentionally bounded to 5-100 like interactive menus, or should it use a
  Plex-specific positive safe-integer ceiling? Resolve this before selecting the helper and align
  `rfmedia.example.yaml` plus `plex-configuration.md`.
- Confirm `CopyConfigOptions.conflictStrategy` is silently dropped by `validateCopyConfig`; if so,
  open a separate issue with the same source-interface/validator evidence.
- Documentation should be minimal: correct the Plex configuration contract and note that previously
  ignored values now take effect; update the live ROADMAP item and avoid duplicating prose across
  README and feature docs.
