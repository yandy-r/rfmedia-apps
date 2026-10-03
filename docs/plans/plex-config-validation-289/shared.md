# Shared Context: Plex Config Validation (#289)

## Objective

Make every declared top-level `PlexConfigOptions` field pass through validated configuration,
repairing `pageSize`, `syncRatingsOnCopy`, and `syncOnCopyDefaults` without changing command,
adapter, or precedence contracts. Add a compile-time drift fence and keep non-Plex audit findings
out of scope.

## Authoritative Contract

- Live issue: #289.
- Audit child: #302 for `CopyConfigOptions.conflictStrategy`.
- `plex.pageSize`: integer 1–1,000 inclusive, using `MEDIA_IDENTITY_MAX_PAGE_SIZE`.
- `plex.syncRatingsOnCopy`: boolean; explicit `false` survives.
- `plex.syncOnCopyDefaults`: object; optional non-empty `popmEmail`; optional exact
  `normalized | stars | percent` scale; `{}` is valid.
- Missing values remain missing; downstream consumers continue applying defaults.
- Unknown-key behavior is unchanged.
- No CLI, Bash, Zsh, Fish, or completion parity source changes are required.

## Architecture and Data Flow

```text
raw YAML/JSON
  -> validateConfig
  -> validatePlexConfigOptions
  -> ConfigFile.plex
  -> getLoadedPlexConfig
     |-> adapters/index -> PlexAdapter -> four page-size consumers
     `-> plex copy / playlist export -> rating-sync defaults
```

The only production boundary to change is `packages/rfmedia-cli/src/lib/config.ts`.

## Existing Patterns to Reuse

- `validateBoundedInteger` for `pageSize`.
- `validateBoolean` for `syncRatingsOnCopy`.
- `validateString` and `VALID_VORBIS_SCALE_VALUES` for nested defaults.
- The nested Plex validators immediately before `validatePlexConfigOptions`.
- The `Exclude<keyof ..., ...>` conditional-`never` fence in
  `packages/rfmedia-cli/src/lib/plan.ts`.
- Compact parameterized invalid cases and `ConfigError.propertyPath` assertions in
  `packages/rfmedia-cli/src/lib/config.test.ts`.

## Files and Responsibilities

| File                                                       | Responsibility                                      |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/config.ts`                   | Runtime validators, assignments, compile-time fence |
| `packages/rfmedia-cli/src/lib/config.test.ts`              | Accepted/rejected config-boundary contract          |
| `packages/rfmedia-cli/src/types/config.ts`                 | Source-of-truth interfaces; likely read-only        |
| `packages/rfmedia-cli/src/types/media-server.ts`           | Shared 1,000 page ceiling; read-only                |
| `packages/rfmedia-cli/docs/features/plex-configuration.md` | Range and activation guidance                       |
| `packages/rfmedia-cli/CHANGELOG.md`                        | Unreleased behavior-changing fix                    |
| `ROADMAP.md`                                               | Live open-work removal/count reconciliation         |
| `docs/roadmap-archive.md`                                  | Closed issue/PR history                             |
| `docs/internal/plex-jwt-deferrals.md`                      | Resolve the recorded #289 deferral                  |

## Critical Tests Only

1. One combined success case proves all three fields survive `validateConfig`.
2. A compact table proves representative rejected values and exact property paths:
   - page size: wrong type, fractional, below range, above range;
   - rating sync: non-boolean;
   - nested defaults: wrong outer shape, invalid email type/emptiness, invalid scale.
3. Existing focused adapter test remains regression evidence; do not add duplicate consumer tests.
4. Typecheck proves the compile-time fence; do not add a runtime test for a type invariant.

## Validation Gates

From repository root unless noted:

```bash
npm run build:common
npm run typecheck -w packages/rfmedia-cli
env -u FORCE_COLOR npx vitest run src/lib/config.test.ts
env -u FORCE_COLOR npx vitest run src/lib/adapters/plex-adapter.test.ts
env -u FORCE_COLOR npm run test:run -w packages/rfmedia-cli
npm run build:all
npm run lint
npm run lint:md
npm run format:check
git diff --check
```

Confirm exact script names against `package.json` before final execution.

## Documentation and Completion Audit

- Explain that existing valid settings start taking effect after upgrade.
- Call out rating metadata writes and hardlink behavior without duplicating existing long-form
  guidance.
- State the 1–1,000 page-size range.
- Refresh ROADMAP totals against the live GitHub inventory immediately before commit/PR.
- Audit `bash.ts`, `zsh.ts`, `fish.ts`, and completion parity tests; record **no change required**
  because the command surface is unchanged.

## Scope Guardrails

- Do not fix child issue #302 in this branch.
- Do not change `loadConfig` fallback semantics or unknown-key policy.
- Do not add a schema library or generic validation framework.
- Do not materialize runtime defaults during validation.
- Do not modify adapter/action behavior unless a focused test proves the config boundary alone is
  insufficient.
