# Architecture Analysis: Copy Conflict Strategy Validation (#302)

## Executive Summary

Issue #302 is a configuration trust-boundary repair. `CopyConfigOptions` declares
`conflictStrategy`, but `validateCopyConfig` creates a fresh allowlisted object without reading
that key, so otherwise valid YAML/JSON loses the value before it reaches shared loaded state. The
smallest complete repair is an explicit four-value validation branch, focused public-boundary
tests, and an adjacent `keyof CopyConfigOptions` exhaustiveness fence modeled on the existing Plex
validator fence.

## Architecture Context

```text
.rfmedia.yaml / .yml / .json
  -> loadConfig (parse, secrets, size/cache policy)
  -> validateConfig
  -> validateCopyConfig
  -> ConfigFile.copy
  -> setLoadedConfig / getLoadedConfig
     |-> MCP copy.album / copy.filter adapters
     `-> CLI copy/verify/sync and copy actions
```

- `validateConfig` is the public synchronous validation boundary. It rejects a non-object `copy`
  section, delegates to `validateCopyConfig`, and returns the reconstructed `ConfigFile`.
- `validateCopyConfig` is an explicit presence-preserving allowlist: every supported property is
  copied only after validation. The missing `conflictStrategy` branch therefore causes a silent
  drop rather than a TypeScript or runtime error.
- `loadConfig` parses search-path candidates and calls `validateConfig`, but intentionally catches
  `ConfigError`, warns, and tries the next candidate. Tests for the issue's required thrown error
  should exercise `validateConfig` directly; changing loader fallback semantics is unrelated.
- `ConflictStrategy` is the authoritative union: `skip | overwrite | rename | ask`. Validation
  must retain exactly these literals without materializing a default.
- MCP copy adapters already resolve `args.conflictStrategy ?? copyConfig.conflictStrategy ??
"skip"` and reject `ask` because MCP cannot prompt. Retaining the field restores this existing
  integration path without adapter changes.
- The interactive `copy` command is not symmetrical: Commander supplies a default `ask`, and
  `buildCopyOptions` validates only `rawOptions.conflictStrategy`, not
  `copyConfig.conflictStrategy`. This is a pre-existing consumer-level caveat; issue #302's stated
  1–2-file validator scope does not authorize a command-precedence change, but end-to-end claims
  about ordinary CLI behavior must account for it.

## Critical Files Reference

| File                                                        | Architectural role                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/types/config.ts`                  | Declares `CopyConfigOptions.conflictStrategy`; source of truth for the fence                      |
| `packages/rfmedia-cli/src/types/conflict.ts`                | Defines the exact four-member `ConflictStrategy` union                                            |
| `packages/rfmedia-cli/src/lib/config.ts`                    | Owns `ConfigError`, `validateCopyConfig`, `validateConfig`, and the analogous Plex fence          |
| `packages/rfmedia-cli/src/lib/config.test.ts`               | Tests private validators through public `validateConfig`; location for accepted/rejected coverage |
| `packages/rfmedia-cli/src/lib/loaded-config.ts`             | Stores the validated `ConfigFile` consumed by commands and adapters                               |
| `packages/rfmedia-cli/src/cli.ts`                           | Loads and publishes validated configuration in the top-level pre-action hook                      |
| `packages/rfmedia-cli/src/mcp/adapters.ts`                  | Existing downstream consumer of configured conflict strategy for album and filter copy            |
| `packages/rfmedia-cli/src/mcp/adapters.spec.ts`             | Existing proof that `ask` is forbidden at the non-interactive MCP boundary                        |
| `packages/rfmedia-cli/src/commands/copy.ts`                 | CLI conflict-strategy default, validation, and plan-freezing semantics; read-only caveat          |
| `docs/plans/plex-config-validation-289/analysis-context.md` | Precedent and original audit disposition for this separately scoped defect                        |

## Cross-Cutting Concerns

- **Runtime safety:** Do not cast arbitrary raw strings directly to `ConflictStrategy`. Validate
  string membership first and throw `ConfigError` with exact `propertyPath`
  `copy.conflictStrategy` for wrong types and unsupported strings.
- **Presence semantics:** Follow the existing
  `"conflictStrategy" in raw && raw["conflictStrategy"] !== undefined` pattern. Omission stays
  omitted; no validator-level default should be introduced.
- **Compile-time drift protection:** A handled-key union plus
  `Exclude<keyof CopyConfigOptions, HandledCopyConfigOptionKey>` and a conditional-`never`
  assignment makes future declared fields fail typecheck until the validator classifies them.
  This is compile-time coverage, not runtime unknown-key rejection.
- **Compatibility:** Unknown keys in fixed config objects are generally ignored by these
  allowlisting validators. Rejecting all unknown `copy` keys would be a broader behavioral change
  and is not required by the issue.
- **Non-interactive behavior:** `ask` is valid configuration data and must survive validation.
  Whether a consumer can use it is enforced later; MCP correctly rejects it at its own boundary.
- **Duplication risk:** The same four literals appear in Commander choices and adapter schemas.
  This repair should avoid a broad enum-centralization refactor; type the validator's local value
  list against `ConflictStrategy` so invalid literals cannot be added accidentally.
- **Documentation/completions:** No user-facing flag or allowed value changes. Bash, Zsh, and Fish
  already expose all four CLI choices, so completion edits are unnecessary. Current documentation
  does not present `copy.conflictStrategy` as a general config option; document only if the final
  implementation intentionally promises a consumer behavior beyond boundary retention.

## Parallelization Opportunities

- Production validation and its compile-time fence are one cohesive `config.ts` task and should
  remain with a single owner.
- Focused `config.test.ts` acceptance/rejection cases can be implemented independently once the
  exact error contract is fixed.
- A read-only consumer/documentation audit can run in parallel with implementation; it should
  explicitly distinguish validator retention, MCP behavior, and ordinary CLI precedence.
- Package typecheck and focused Vitest execution can run independently after source and test edits
  settle; broader repository gates follow only if the implementation scope expands.

## Implementation Constraints

- Accept and preserve exactly `skip`, `overwrite`, `rename`, and `ask`.
- Reject unsupported strings and non-string values with `ConfigError`; assert
  `error.propertyPath === "copy.conflictStrategy"` rather than only matching the message.
- Add the branch beside `force`/`convertFormat` in `validateCopyConfig`, keeping the established
  explicit assignment style and avoiding raw-object spread or schema-framework refactoring.
- Fence every current `keyof CopyConfigOptions`, not only `conflictStrategy`; place the fence
  immediately after `validateCopyConfig` as the local equivalent of
  `_plexValidatorCoversConfigOptions`.
- Use `validateConfig({ copy: { conflictStrategy: value } }, configPath)` for focused tests.
  Parameterize all four valid values and include at least one invalid string; wrong-type coverage
  is advisable because raw YAML/JSON is `unknown`.
- Treat `undefined` as absence and do not introduce a config default. Preserve existing CLI
  option-source and copy-plan freezing semantics.
- Do not change `loadConfig` fallback policy, MCP's rejection of `ask`, command definitions,
  conflict resolution actions, shell completions, public types, dependencies, or database/API
  surfaces as part of the validator repair.
- Required focused verification is
  `npm run typecheck -w packages/rfmedia-cli` and
  `env -u FORCE_COLOR npx vitest run src/lib/config.test.ts`; typecheck is the proof that the
  exhaustiveness fence is active.
