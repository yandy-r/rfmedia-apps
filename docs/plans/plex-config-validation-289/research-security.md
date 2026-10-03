# Security Research: Plex Config Validation (#289)

## Executive Summary

No CRITICAL issue is inherent in restoring these three local configuration fields. The material
risk is upgrade behavior: an existing, previously ignored `syncRatingsOnCopy: true` can begin
writing ratings to copied files and, with hardlinks, to source files. `pageSize` also reaches every
Plex adapter family, so it must retain a small upper bound. The implementation should validate and
copy exact fields only, reject malformed nested values, preserve secret redaction, and add no
dependency.

Research date: 2026-07-30. Evidence: issue #289; `src/types/config.ts`;
`src/lib/config.ts`; `src/lib/adapters/index.ts`; `src/lib/adapters/plex-adapter.ts`;
`src/actions/plex-copy.ts`; and `src/actions/plex-playlist.ts`.

## Findings by Severity

No CRITICAL findings were identified.

| ID  | Severity | Finding                                                                                                                                                                    | Mitigation                                                                                                                                                                                                                                                                                            | Confidence |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| S1  | WARNING  | Restoring `syncRatingsOnCopy` activates file-metadata writes for configs that were previously inert; hardlinks make those writes affect source files.                      | Keep missing/`false` non-mutating, preserve the hardlink warning and dry-run behavior, add an upgrade/release note, and test loaded-config-to-consumer behavior for `false`, `true`, and hardlink use.                                                                                                | High       |
| S2  | WARNING  | An unchecked `pageSize` can amplify response memory, latency, and Plex load across query, identity, playlist, and collection capabilities.                                 | Use the existing `validatePageSize` integer range of 5–100 before persistence; reject `NaN`, infinity, fractions, strings, and out-of-range values. Keep consumer validation as defense in depth.                                                                                                     | High       |
| S3  | WARNING  | `syncOnCopyDefaults` can hide malformed or misspelled nested values; a very large `popmEmail` is repeated into MP3 POPM tags and can amplify storage/work per copied file. | Require a non-null, non-array object; accept only `popmEmail` and `vorbisScale`; reject unknown keys; require a non-empty, NUL-free, byte-bounded identifier and the exact scale enum. Apply the same bound to CLI consumers or track that consistency separately.                                    | High       |
| S4  | ADVISORY | A compile-time coverage fence prevents future declared Plex fields from being silently dropped, but it does not reject runtime unknown keys.                               | Define the validated key list with `satisfies readonly (keyof PlexConfigOptions)[]`, prove `Exclude<keyof PlexConfigOptions, Keys>` is `never`, and keep explicit runtime branches. Consider exact unknown-key rejection for the whole `plex` object as a separately called-out compatibility change. | High       |
| S5  | ADVISORY | `plex.token` remains secret, while `popmEmail` may be personal data that becomes embedded in output media.                                                                 | Never log or serialize the raw Plex config; retain recursive token redaction and type-only validation errors; document that `popmEmail` is written into MP3 metadata and use `no@email` when identity disclosure is unwanted.                                                                         | High       |
| S6  | ADVISORY | A manual audit of other `*ConfigOptions` validators can miss the same declaration/validator drift.                                                                         | Record the audited type-to-validator pairs, test any discrepancy, and file separate issues rather than widening #289. Prefer reusable compile-time coverage fences for explicit-copy validators.                                                                                                      | Medium     |

## Auth

Issue #289 must not change credential selection, origin binding, redirects, or token injection.
`pageSize` is forwarded only after the existing Plex connection is resolved; the rating defaults
remain local. Tests should assert the loaded values do not appear in adapter credentials or errors.

## Data Protection

S1 and S5 govern the only data-impact change. Rating synchronization mutates destination metadata
and can mutate source data through a shared hardlink inode. `popmEmail` is not an authentication
secret, but it is durable metadata and should not be printed in diagnostics. `plex.token` must
remain redacted during config merge, validation, and debug logging.

## Dependency Security

S6 applies. No new package is needed: the loader already uses `js-yaml` with `CORE_SCHEMA`, enforces
the shared 1 MiB config-file limit, and has the required primitive validators. Do not modify the
lockfile or introduce a schema library for three fields.

## Input Validation

- S2: validate `pageSize` once at the config boundary as an integer in `[5, 100]`.
- S3: reject `null`, arrays, primitives, unknown nested keys, invalid enum values, NUL, and
  oversized UTF-8 identifiers; treat `undefined` as absent but reject explicit `null`.
- S4: construct a fresh `PlexConfigOptions`; never spread raw YAML/JSON objects into it.
- Test accepted persistence and rejected values through the real config loader, not a mocked typed
  object, because the existing mock is what masked this defect.

## Infrastructure

There is no listener, database migration, new filesystem path, or deployment change. S2 is the
only network/resource effect: a validated value controls bounded outbound Plex pagination. Existing
config size and YAML core-schema controls remain unchanged.

## Secure Coding

Implement S4 without `as PlexConfigOptions`, a catch-all index signature, or a broad cast that
defeats the fence. The fence must cover every declared key, while every runtime branch must invoke
an appropriate validator. Keep the nested object an explicit allowlist. Run typecheck plus focused
config and adapter tests; a compile-fail/type assertion should prove adding a field breaks the
coverage fence.

## Trade-offs

Rejecting unknown `plex` keys catches typos but may break configs that currently carry ignored
extensions; S4 therefore separates compile-time exhaustiveness from that runtime policy. A strict
`popmEmail` byte cap is safer than the current overall 1 MiB config/worker ceiling, but consistency
requires applying it to CLI overrides too. Neither trade-off justifies passing unknown values
through.

## Open Questions

- Should all unknown keys under `plex` fail now, or should #289 reject only unknown keys inside the
  newly restored `syncOnCopyDefaults` block and track root strictness separately?
- What UTF-8 byte limit should `popmEmail` use across config and CLI entry points?
- Does the release note need a dedicated warning that old `syncRatingsOnCopy: true` configs become
  active on upgrade, especially when copy defaults use hardlinks?
