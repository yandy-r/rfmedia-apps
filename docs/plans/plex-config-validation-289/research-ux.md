# UX Research: Plex Config Validation (#289)

## Executive Summary

The user-facing defect is silent non-activation: `plex.pageSize`, `plex.syncRatingsOnCopy`, and
`plex.syncOnCopyDefaults` are documented or typed, but disappear while loading configuration.
The repair should make valid values take effect on the next ordinary command, reject invalid values
with exact dotted paths, and require no migration command or config rewrite.

The main upgrade risk is activation, not syntax compatibility. An existing
`syncRatingsOnCopy: true` will begin writing ratings during `plex copy` and `plex playlist export`;
an existing `pageSize` will change Plex request batching. Release notes should explicitly tell users
to review these three keys before upgrading.

**Confidence**: High — confirmed in the declared types, explicit validator allowlist, downstream
default resolution, issue #289, and current Plex configuration documentation.

## User Workflows

### New or edited configuration

1. The user adds one or more keys under `plex` in `.rfmedia.yaml`.
2. The next normal `rfmedia` invocation loads and validates the file; there is no activation step.
3. Valid values survive in the loaded config and reach their consumers.
4. Explicit command flags remain higher priority than config defaults.

Recommended minimal example:

```yaml
plex:
  pageSize: 100
  syncRatingsOnCopy: true
  syncOnCopyDefaults:
    popmEmail: "user@example.com"
    vorbisScale: "stars"
```

### Upgrade with keys already present

- Before upgrade, the three values have no effect; after upgrade, valid values become active.
- `syncOnCopyDefaults` has an observable effect only when rating sync is enabled by config or CLI.
- Hardlink users retain the existing warning that rating writes also modify the source inode.
- Recovery is to edit or remove the key and rerun the same command; no state migration is required.

**Confidence**: High — `plex-copy.ts` and `plex-playlist.ts` resolve CLI values before config
defaults, then built-in defaults.

## CLI/Config UX Best Practices

- Preserve exact YAML key spelling and camelCase used by `PlexConfigOptions`.
- Treat all three as optional defaults; do not write defaults back into the user's file.
- Validate at config load so failures occur before Plex requests or file writes.
- Use the full dotted path in both the message and `ConfigError.propertyPath`.
- State allowed enum values and numeric bounds in the error itself.
- Do not add prompts, a new command, or a UI surface for this maintenance fix.
- Keep one canonical copy-ready example synchronized across `rfmedia.example.yaml` and the Plex
  configuration guide; add `pageSize` to the guide's full reference.
- Add an upgrade note because restoring `syncRatingsOnCopy` can enable a side effect.

## Error Handling

| Invalid input                         | Preferred message contract                                                                           | Recovery                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `pageSize` wrong type/out of range    | `Expected integer between <min> and <max> for plex.pageSize, got <value>`                            | Choose an in-range integer or remove the key |
| `syncRatingsOnCopy` not boolean       | `Expected boolean for plex.syncRatingsOnCopy, got <type>`                                            | Use unquoted `true`/`false`                  |
| `syncOnCopyDefaults` null/list/scalar | `Expected object for plex.syncOnCopyDefaults, got <type>`                                            | Use a YAML mapping or remove it              |
| `popmEmail` empty/non-string          | `Expected non-empty string for plex.syncOnCopyDefaults.popmEmail, got <type>`                        | Supply a non-empty identifier                |
| `vorbisScale` unsupported             | `Invalid plex.syncOnCopyDefaults.vorbisScale: <value>. Must be 'normalized', 'stars', or 'percent'.` | Select a listed value                        |

`loadConfig()` currently logs a warning and tries the next config location after `ConfigError`.
Changing that global fallback policy is out of scope, but messages must include the file and dotted
property path so users can identify why a higher-priority file was skipped. Tests should assert
both message content and `propertyPath`.

**Confidence**: High — wording follows existing `validateBoolean`, `validateString`,
`validatePlexSyncDefaults`, nested-object checks, and `loadConfig()` behavior.

## Performance UX

`pageSize` is a throughput/latency tradeoff: larger pages generally mean fewer Plex requests but
larger responses and more work per request. Activation may therefore change elapsed time, request
count, and memory shape without changing results. Rating sync adds metadata-write work per eligible
copied track; existing progress and hardlink warnings are sufficient, so this fix should not add
new progress UI.

**Confidence**: Medium — data flow is confirmed, but workload impact depends on library and server.

## Competitive/Convention Analysis

No external comparison is needed: this is a repository-contract repair. Local convention is
`ConfigError(message, configPath, propertyPath)`, dotted paths for nested keys, explicit accepted
values, config defaults overridden by CLI values, and defaults applied at the consumption site.
The compile-time allowlist fence is developer-facing but materially prevents this UX failure from
recurring.

One convention is unresolved: the generic config `validatePageSize` accepts 5–100, while Plex
adapters generally accept positive safe integers and the identity capability caps at 1,000.
The chosen Plex config range should be deliberate and documented, not inherited accidentally from
interactive selector pagination.

**Confidence**: High for conventions; Medium for the appropriate Plex-specific bound.

## Recommendations

1. Round-trip all three fields and add the compile-time exhaustiveness fence.
2. Preserve CLI-over-config precedence and consumption-site defaults.
3. Validate nested shape and leaf values with exact dotted property paths.
4. Add a release/changelog note headed as a behavior activation on upgrade.
5. Update the smallest canonical examples/reference tables; avoid unrelated documentation cleanup.
6. Test one accepted and representative rejected value per field, including nested paths.
7. Keep the broader config-type audit developer-facing; file separate issues for unrelated drops.

## Open Questions

1. Should `plex.pageSize` be 5–100, 1–1,000, or another explicit range? Align the validator,
   adapter constraints, error text, and docs.
2. Where is the project's release-note surface for an upgrade activation with possible file-write
   side effects?
3. Should a separate issue address the global behavior where invalid high-priority config falls
   through to a lower-priority file/defaults after only a warning?
