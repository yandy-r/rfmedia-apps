# Analysis Context: Plex Config Validation (#289)

## Executive Summary

Issue #289 is a trust-boundary repair, not a new feature surface. Three declared
`PlexConfigOptions` fields are discarded by the explicit allowlist in
`validatePlexConfigOptions`; the implementation must validate and retain them, preserve downstream
defaults and CLI precedence, and add a compile-time fence against future top-level drift. The
authoritative contract resolves research disagreements in favor of a `pageSize` range of 1–1,000
and the existing permissive unknown-key policy.

## Architecture Context

```text
raw YAML/JSON
  -> validateConfig
  -> validatePlexConfigOptions
  -> ConfigFile.plex / getLoadedPlexConfig
     |-> adapters/index -> PlexAdapter -> query, identity, playlist, collection paging
     `-> plex copy / playlist export -> rating-sync defaults
```

- `packages/rfmedia-cli/src/lib/config.ts` is the only production boundary that changes. It creates
  a fresh allowlisted object, so a missing assignment silently makes a declared option inert.
- `pageSize` feeds four Plex capability families. Validate it before adapter construction against
  the shared `MEDIA_IDENTITY_MAX_PAGE_SIZE` ceiling to prevent later `RangeError` failures.
- `syncRatingsOnCopy` and `syncOnCopyDefaults` are already consumed by copy and playlist-export
  actions. Explicit action/CLI values remain higher priority than loaded config.
- Defaults remain consumption-site policy: omission must still resolve downstream to `false`,
  `"no@email"`, and `"normalized"` rather than being materialized during validation.
- The type-level fence supplements runtime validation. It should classify every top-level
  `keyof PlexConfigOptions`, including `auth`, but does not automatically fence nested interfaces.

## Critical Files Reference

| File                                                       | Role in the change                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/config.ts`                   | Add nested validation, three retained assignments, imports, and top-level drift fence |
| `packages/rfmedia-cli/src/lib/config.test.ts`              | Prove accepted round-trip and exact-path rejection at the real config boundary        |
| `packages/rfmedia-cli/src/types/config.ts`                 | Source-of-truth interfaces; expected to remain read-only                              |
| `packages/rfmedia-cli/src/types/media-server.ts`           | Owns the shared 1,000 page ceiling; read-only                                         |
| `packages/rfmedia-cli/src/lib/plan.ts`                     | Existing conditional-`never` exhaustiveness-fence precedent                           |
| `packages/rfmedia-cli/src/lib/adapters/index.ts`           | Transfers loaded `pageSize` into adapter configuration; read-only                     |
| `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`    | Fans `pageSize` into four capability factories; read-only                             |
| `packages/rfmedia-cli/src/actions/plex-copy.ts`            | Existing CLI/config/default precedence and metadata writes; read-only                 |
| `packages/rfmedia-cli/src/actions/plex-playlist.ts`        | Existing playlist-export precedence and defaults; read-only                           |
| `packages/rfmedia-cli/docs/features/plex-configuration.md` | Document range and upgrade activation risk                                            |
| `packages/rfmedia-cli/CHANGELOG.md`                        | Record the behavior-changing fix under Unreleased                                     |
| `ROADMAP.md`                                               | Remove completed #289 and reconcile live counts                                       |
| `docs/roadmap-archive.md`                                  | Archive #289 with the actual closing PR                                               |
| `docs/internal/plex-jwt-deferrals.md`                      | Mark the recorded #289 deferral resolved                                              |

## Patterns to Follow

- Reuse `validateBoundedInteger`, `validateBoolean`, `validateString`,
  `VALID_VORBIS_SCALE_VALUES`, and `MEDIA_IDENTITY_MAX_PAGE_SIZE`; add no dependency.
- Place `validatePlexSyncOnCopyDefaults` beside `validatePlexSyncDefaults`, but do not reuse the
  broader validator because it also accepts `prefer` and `onlyRated`.
- Guard every optional field with the established presence-plus-`undefined` check so explicit
  `false` survives and missing values remain missing.
- Reject `null`, arrays, and primitives at `plex.syncOnCopyDefaults`; accept `{}` and validate
  present leaves with exact dotted `ConfigError.propertyPath` values.
- Mirror the `Exclude<keyof ..., ...>` conditional-`never` fence from
  `packages/rfmedia-cli/src/lib/plan.ts` and keep it adjacent to the Plex validator.
- Use one combined accepted case plus compact parameterized invalid cases in `config.test.ts`;
  typecheck, not a runtime test, proves the compile-time invariant.

## Cross-Cutting Concerns

- Existing valid configuration starts taking effect after upgrade. In particular,
  `syncRatingsOnCopy: true` enables metadata writes, and hardlinks can expose those writes through
  the shared source inode; documentation and changelog must say so.
- Larger page sizes trade fewer Plex requests for larger responses and more work. The inclusive
  1–1,000 bound is repository policy and the tightest shared downstream contract.
- Preserve current `loadConfig` warn-and-fallback semantics, token redaction, config-size limits,
  YAML parsing, and unknown-key behavior; all are outside #289.
- The audit-only `CopyConfigOptions.conflictStrategy` gap is owned by child issue #302. No non-Plex
  validation change belongs in this branch.
- No command or option changes occur. Bash, Zsh, Fish, and completion parity sources require a
  read-only audit and an explicit “no change required” result, not edits.

## Parallelization Opportunities

- After the runtime contract is fixed, config-boundary tests can be owned independently from
  documentation because their files do not overlap.
- The feature guide and changelog can be updated together while focused tests run.
- ROADMAP, archive, and deferral closeout form one late documentation task because they depend on
  live issue counts and the actual closing PR identifier.
- Focused config and adapter regressions can run independently after the production/test changes
  settle; full package and repository gates follow them.

## Implementation Constraints

- Accept `pageSize` integers from 1 through `MEDIA_IDENTITY_MAX_PAGE_SIZE` (1,000), inclusive;
  reject wrong types, fractions, zero/negative values, and values above the ceiling.
- Accept only literal booleans for `syncRatingsOnCopy`; no coercion.
- Accept `syncOnCopyDefaults: {}`; require a non-empty string for present `popmEmail` and exactly
  `normalized | stars | percent` for present `vorbisScale`.
- Do not use interactive `validatePageSize` (5–100), spread raw fields, apply runtime defaults,
  reject unknown keys, add NUL/byte/email-format constraints, or introduce a schema framework.
- Do not modify adapters, actions, public types, config templates, CLI commands, or completions
  unless focused boundary evidence disproves the documented architecture.
- Refresh ROADMAP facts from live GitHub state immediately before closeout; do not apply stale
  arithmetic from a research snapshot.

## Key Recommendations

1. Implement the nested validator, three guarded assignments, and adjacent handled-key fence as one
   cohesive `config.ts` change.
2. Prove all three formerly dropped values survive `validateConfig`, including explicit `false`,
   and assert representative failures by exact property path.
3. Keep consumer tests as regression evidence; do not duplicate adapter/action behavior already
   covered elsewhere.
4. Communicate the upgrade activation risk and 1–1,000 bound, then update live planning records only
   when final issue/PR state is known.
5. Run focused type/config/adapter gates before the full package and repository validation suite.
