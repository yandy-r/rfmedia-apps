# Pattern & Code Analysis: Copy Conflict Strategy Validation

## Executive Summary

Issue #302 is confined to the existing configuration boundary. `CopyConfigOptions` already
declares `conflictStrategy?: ConflictStrategy`, and downstream MCP adapters already read
`config.copy.conflictStrategy`, but `validateCopyConfig()` never copies or validates the raw field.
The smallest consistent fix is to validate the four existing strategies in
`packages/rfmedia-cli/src/lib/config.ts`, preserve the selected literal in the returned object, and
add a compile-time coverage fence beside that validator.

The closest repository patterns are the enum-like `plex.auth.mode` validation and the
`PlexConfigOptions` validator coverage fence. Focused Vitest coverage belongs in the existing
`packages/rfmedia-cli/src/lib/config.test.ts` suite through the public `validateConfig()` entry
point. No type, command, completion, plan schema, database, generated client, or dependency change
is required.

## Implementation Patterns

### Validate enum-like configuration at the config boundary

Follow `VALID_PLEX_AUTH_MODES` and `validatePlexAuthConfigOptions()` in
`packages/rfmedia-cli/src/lib/config.ts`:

- define the allowed literals near the other configuration validation constants;
- type the allowlist against `ConflictStrategy` so misspelled members fail compilation;
- accept only a string present in `skip`, `overwrite`, `rename`, and `ask`;
- throw `ConfigError` with `configPath` and the exact property path
  `copy.conflictStrategy`;
- assign the narrowed value to `config.conflictStrategy` without defaulting or transforming it.

The established field pattern is:

```text
field exists and is not undefined
  -> validate type and allowlisted value
  -> throw ConfigError with full property path on failure
  -> assign the original valid literal to the typed result
```

Keep `undefined` equivalent to omission, as every other field in `validateCopyConfig()` does.
Defaults belong at consumption sites and must not be written into the validated config.

### Mirror the existing validator coverage fence

`validatePlexConfigOptions()` is followed by:

```ts
type HandledPlexConfigOptionKey = /* explicit field union */;
type UnhandledPlexConfigOptionKeys =
  Exclude<keyof PlexConfigOptions, HandledPlexConfigOptionKey>;
const _plexValidatorCoversConfigOptions:
  UnhandledPlexConfigOptionKeys extends never ? true : never = true;
void _plexValidatorCoversConfigOptions;
```

Add the analogous `HandledCopyConfigOptionKey`,
`UnhandledCopyConfigOptionKeys`, and `_copyValidatorCoversConfigOptions` fence immediately after
`validateCopyConfig()`. Its explicit handled-key union must include every current
`CopyConfigOptions` field, including `conflictStrategy`. This is a compile-time drift guard: adding
a future interface member without updating the validator makes typecheck fail instead of silently
dropping another configured value.

This fence complements validation; it is not a runtime unknown-key allowlist. Existing config
validators generally ignore unsupported raw sibling keys, so issue #302 should not introduce
runtime unknown-key rejection for `copy`.

### Add contract-focused Vitest cases

Extend the top-level `describe("validateConfig")` suite in
`packages/rfmedia-cli/src/lib/config.test.ts`. Tests should call exported `validateConfig()` because
`validateCopyConfig()` is intentionally private.

- Use `it.each(["skip", "overwrite", "rename", "ask"] as const)` to prove every
  `ConflictStrategy` literal survives as `config.copy?.conflictStrategy`.
- Use one invalid string representative, catch the error, assert
  `error instanceof ConfigError`, and assert `propertyPath === "copy.conflictStrategy"`.
- Optionally assert the message names the valid strategies if the implementation follows the
  nearby `plex.auth.mode` diagnostic, but the typed error and exact property path are the essential
  contract.

The compile-time fence is verified by TypeScript, not by a runtime test.

## Existing Code Structure

| Path                                               | Existing responsibility                                         | Relevance to issue #302                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/types/config.ts`         | Declares `ConfigFile` and `CopyConfigOptions`                   | Already contains `conflictStrategy?: ConflictStrategy`; remains the source contract             |
| `packages/rfmedia-cli/src/types/conflict.ts`       | Owns the `ConflictStrategy` union                               | Canonical values are `skip`, `overwrite`, `rename`, and `ask`                                   |
| `packages/rfmedia-cli/src/types/index.ts`          | Type barrel used by `config.ts`                                 | Already exports `ConflictStrategy`; add it to the existing type import if needed                |
| `packages/rfmedia-cli/src/lib/config.ts`           | Parses, validates, and returns typed configuration              | Add validation/preservation in `validateCopyConfig()` and the copy coverage fence               |
| `packages/rfmedia-cli/src/lib/config.test.ts`      | Colocated Vitest coverage for public configuration validation   | Add focused valid-literal and invalid-path cases here                                           |
| `packages/rfmedia-cli/src/mcp/adapters.ts`         | Resolves MCP copy options from arguments, config, then defaults | Already consumes `copyConfig.conflictStrategy`; the validator fix makes this path effective     |
| `packages/rfmedia-cli/src/mcp/schema.ts`           | Validates MCP tool arguments                                    | Confirms the same four-value strategy allowlist                                                 |
| `packages/rfmedia-cli/src/commands/copy.ts`        | Resolves Commander copy options and plan-freezing behavior      | Has its own four-value validation and a Commander default of `ask`; not part of this config fix |
| `packages/rfmedia-cli/src/commands/verify.ts`      | Resolves verify/fix conflict behavior                           | Repeats the same four literals; no change required                                              |
| `packages/rfmedia-cli/src/lib/plan.ts`             | Strictly validates persisted copy plans                         | Uses the same four literals at `execution.conflictStrategy`; no schema change required          |
| `packages/rfmedia-cli/src/lib/error-formatters.ts` | Presents `ConfigError` diagnostics                              | Renders `propertyPath` as the invalid configuration location                                    |

## Code Conventions

- Use strict TypeScript and type-only imports with local `.js` specifiers.
- Keep configuration validators pure: accept raw values plus `configPath`, return a fresh typed
  object, and perform no logging or default application.
- Use bracket access for raw records (`raw["conflictStrategy"]`) and explicit
  `"conflictStrategy" in raw` checks, matching the rest of `validateCopyConfig()`.
- Preserve exact dotted property paths in both the error message context and
  `ConfigError.propertyPath`.
- Use a typed literal allowlist and `includes()` narrowing consistent with `validateConvertFormat`
  and `plex.auth.mode`; do not cast an arbitrary string into the returned config before validation.
- Keep the exhaustiveness fence adjacent to the validator so the interface-to-validator
  relationship remains visible.
- Tests use Vitest, public entry points, `it.each` for compact literal matrices, and
  `vi.clearAllMocks()` rather than `vi.resetAllMocks()`.
- Do not create a new validator module or shared strategy registry for this one-field repair. The
  repository currently repeats the four values across Commander, MCP, plan, and resolver
  boundaries, and consolidating all of them would widen the change unnecessarily.

## Integration Points

The configuration flow is:

```text
YAML/JSON parse
  -> validateConfig(raw, configPath)
  -> validateCopyConfig(raw.copy, configPath)
  -> ConfigFile.copy.conflictStrategy
  -> getLoadedConfig()
  -> downstream option resolution
```

After the fix, MCP album and filter copy builders in
`packages/rfmedia-cli/src/mcp/adapters.ts` will observe precedence as:

```text
MCP argument -> config.copy.conflictStrategy -> "skip"
```

The MCP boundary then rejects `ask` because it cannot prompt interactively. Configuration
validation must still accept `ask`; execution-mode restrictions belong to the consumer, not the
shared config loader.

The CLI copy and verify commands independently validate Commander values and currently default
`--conflict-strategy` to `ask`. Copy plan generation also strips a non-CLI default before sealing a
plan. Those behaviors are separate from preserving a valid configuration value and should remain
unchanged for this issue.

Focused verification should run the single config test file and the rfmedia TypeScript check. The
repository scripts support:

```bash
npm run test:run -w packages/rfmedia-cli -- src/lib/config.test.ts
npm run typecheck -w packages/rfmedia-cli
```

## Gotchas and Warnings

- `loadConfig()` catches `ConfigError`, warns, and continues to lower-priority search paths. Test
  the requested typed exception through `validateConfig()`; an end-to-end `loadConfig()` test would
  instead need to assert warning/fallback behavior.
- Do not reject `ask` during config validation. It is valid for interactive CLI use even though
  MCP adapters reject it after option resolution.
- Do not default an omitted strategy inside `validateCopyConfig()`. Consumers intentionally have
  different defaults and execution restrictions.
- The compile-time `keyof CopyConfigOptions` fence catches future interface fields omitted from
  the validator, but it does not validate untrusted runtime keys. Adding
  `rejectUnknownConfigKeys()` would be a separate behavior change.
- The copy command currently derives its strategy from Commander's `rawOptions.conflictStrategy`,
  whose option definition defaults to `ask`; it does not fall back to
  `copyConfig.conflictStrategy`. Therefore this issue directly repairs config round-tripping and
  existing config consumers such as MCP, but changing CLI precedence would require coordinated
  handling of Commander value sources and plan-freezing semantics.
- Do not change `ConflictStrategy`, MCP schemas, plan schemas, shell completions, or copy/verify
  resolution maps. All already agree on the four valid literals.
- Add the coverage fence only after all current `CopyConfigOptions` keys are enumerated; otherwise
  typecheck will correctly fail on pre-existing fields unrelated to `conflictStrategy`.
