# External Research: Plex Config Validation (#289)

## Executive Summary

Issue [#289](https://github.com/yandy-r/rfmedia-apps/issues/289) is a local config-boundary defect,
not an external API integration. No new dependency, Plex endpoint, SDK, authentication scope, or
wire-format work is required. Add validated branches for `pageSize`, `syncRatingsOnCopy`, and
`syncOnCopyDefaults`; preserve omission; and add the requested compile-time drift fence.

**Confidence**: High — confirmed from the issue, current validator/types, consumers, manifest, and
official TypeScript/Plex documentation.

A key-coverage audit found one other dropped field: `CopyConfigOptions.conflictStrategy`. Issue
[#289](https://github.com/yandy-r/rfmedia-apps/issues/289) says unrelated audit findings should be
filed separately, so do not fix it opportunistically.

**Confidence**: High — AST comparison of 32 direct interface/validator pairs plus source inspection
found only that field and the three issue fields.

## Primary APIs/External Semantics with Official URLs

- TypeScript [`keyof`](https://www.typescriptlang.org/docs/handbook/2/keyof-types.html) produces an
  object's key union; [`Exclude`](https://www.typescriptlang.org/docs/handbook/utility-types.html#excludeuniontype-excludedmembers)
  removes handled keys; and [`never` exhaustiveness](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking)
  turns a new unhandled member into a compile error. The `keyof`/utility pages were updated July 27,
  2026; the narrowing page was checked July 30, 2026. **Confidence**: High — official language docs.
- [`satisfies`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)
  can additionally check a literal key manifest without widening it. It was introduced in TS 4.9;
  this package declares TS `^5.7.0`. **Confidence**: High.
- The official [Plex PMS pagination docs](https://developer.plex.tv/pms/#section/API-Info/Pagination)
  define `X-Plex-Container-Start` and `X-Plex-Container-Size`, require clients to inspect the actual
  returned page, and publish no universal maximum. The PMS 1.2.2 page was checked July 30, 2026.
  Therefore the upper bound is repository policy. The strictest current consumer is
  `MEDIA_IDENTITY_MAX_PAGE_SIZE = 1_000`; use `1..1_000` so the existing value `250` remains valid
  and all consumers fail early consistently. **Confidence**: High for Plex semantics; Medium-High
  for choosing `1_000`, which is a repository inference.
- The stable [ID3v2.3 POPM specification](https://id3.org/id3v2.3.0#4.18._Popularimeter) (last
  edited April 19, 2020) defines a user email/identifier, rating byte, and optional counter.
  `popmEmail` should be non-empty but need not be network-verified. The
  [Xiph Vorbis comment specification](https://xiph.org/vorbis/doc/Vorbis_I_spec.html#x1-810005)
  permits vendor fields but standardizes no `RATING` scale; `normalized | stars | percent` is
  rfmedia policy. **Confidence**: High — primary, stable format specifications.

## Libraries and SDKs

No new library is needed. Continue using `js-yaml`, local `ConfigError` helpers, and the existing
Plex adapter. `node-id3`/`flac-metadata` already implement downstream writes. Adding AJV, Zod, or a
Plex SDK would create a second validation/integration model for no benefit.

**Confidence**: High — confirmed from `packages/rfmedia-cli/package.json`, the lockfile, and source.

## Integration Patterns

| Field                | Accept                           | Reject                                |
| -------------------- | -------------------------------- | ------------------------------------- |
| `pageSize`           | integer `1..1_000`               | other type, fraction, `<=0`, `>1_000` |
| `syncRatingsOnCopy`  | boolean                          | non-boolean                           |
| `syncOnCopyDefaults` | non-null, non-array object       | primitive, `null`, array              |
| `.popmEmail`         | non-empty string                 | non-string/blank                      |
| `.vorbisScale`       | `normalized`, `stars`, `percent` | other value/type                      |

- Validate at `validatePlexConfigOptions`, not later during adapter construction.
- Factor/reuse leaf checks from `validatePlexSyncDefaults`, but use a dedicated nested validator:
  the broader validator also accepts `prefer` and `onlyRated`.
- Put the handled-key union/fence next to the validator and mirror `src/lib/plan.ts`.
- Test raw-config loading: one positive case proves all three values survive; compact rejection cases
  cover each field/nested shape. Downstream paging/copy tests already cover runtime behavior.
- Audit result: all other direct config fields had validation paths except
  `copy.conflictStrategy`; file it separately.

**Confidence**: High — these patterns match the defect boundary and existing repository practice.

## Constraints and Gotchas

- Plex can return fewer items than requested; keep response-driven pagination termination.
- Do not reuse UI `MIN_PAGE_SIZE=5`/`MAX_PAGE_SIZE=100`; those protect terminal rendering and would
  reject the existing Plex fixture value `250`.
- Preserve absent keys so consumption defaults remain authoritative: `false`, `"no@email"`,
  `"normalized"`.
- Users with these YAML keys will see a behavior change because ignored values start taking effect;
  note it as a fix in the repository's release/roadmap mechanism.
- `plex-configuration.md` already claims sync-on-copy works, but does not clearly document
  `pageSize`; add its validated range if that doc changes.
- That doc also contains older `ratingSyncDefaults`/numeric `vorbisScale` examples. This is
  pre-existing drift; avoid expanding #289 without explicit scope.

⚠️ **Freshness Note**: ID3's page is old but specifies a stable format. Plex and TypeScript sources
were checked July 30, 2026.

## Code Examples

```ts
type ValidatedPlexConfigKey =
  | "url"
  | "token"
  | "scanAfterCopy"
  | "libraryName"
  | "scanPerSource"
  | "libraries"
  | "pageSize"
  | "defaultFilters"
  | "allowedLibraryRoots"
  | "syncDefaults"
  | "playlistDefaults"
  | "cache"
  | "syncRatingsOnCopy"
  | "syncOnCopyDefaults"
  | "auth";
type MissingPlexConfigKey = Exclude<keyof PlexConfigOptions, ValidatedPlexConfigKey>;
const _plexValidatorCoversOptions: MissingPlexConfigKey extends never ? true : never = true;
void _plexValidatorCoversOptions;

if ("pageSize" in raw && raw["pageSize"] !== undefined) {
  config.pageSize = validateBoundedInteger(
    raw["pageSize"],
    1,
    MEDIA_IDENTITY_MAX_PAGE_SIZE,
    "plex.pageSize",
    configPath,
  );
}
```

## Open Questions

1. Import shared `MEDIA_IDENTITY_MAX_PAGE_SIZE`, or define a Plex-config constant at the same value?
   Prefer sharing unless maintainers expect those boundaries to diverge.
2. Create the separate `copy.conflictStrategy` issue during #289 closeout or report it in the PR?
3. Is `ROADMAP.md` sufficient for the behavior-change note, or is there another changelog?
