# Copy Conflict Strategy Validation (#302)

The `rfmedia` configuration loader parses YAML or JSON, validates each top-level section, and
reconstructs a typed `ConfigFile` before publishing it through the loaded-config state. Although
`CopyConfigOptions` declares `conflictStrategy`, the explicit `validateCopyConfig` allowlist omits
that field, so valid input is silently discarded before existing consumers such as the MCP copy
adapters can read it. The repair belongs at this validation boundary: accept and retain exactly
the four declared strategies, reject invalid raw values with the precise property path, and add a
compile-time fence so future declared copy options cannot be omitted unnoticed.

## Relevant Files

- `packages/rfmedia-cli/src/types/config.ts`: Declares every `CopyConfigOptions` key.
- `packages/rfmedia-cli/src/types/conflict.ts`: Defines the four valid conflict strategies.
- `packages/rfmedia-cli/src/types/index.ts`: Re-exports `ConflictStrategy` for config validation.
- `packages/rfmedia-cli/src/lib/config.ts`: Owns `validateCopyConfig` and `ConfigError`.
- `packages/rfmedia-cli/src/lib/config.test.ts`: Tests validation through `validateConfig`.
- `packages/rfmedia-cli/src/mcp/adapters.ts`: Already consumes the configured strategy.
- `packages/rfmedia-cli/src/commands/copy.ts`: Read-only context for unchanged CLI precedence.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Bash value-parity audit target.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Zsh value-parity audit target.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Fish value-parity audit target.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Completion parity tests.
- `packages/rfmedia-cli/CHANGELOG.md`: Narrow release note for validation and retention.
- `ROADMAP.md`: Live #302 priority and open-work tracking.

## Relevant Patterns

**Presence-preserving validation**: Fixed-shape validators check that a raw key exists and is not
`undefined`, validate the unknown value, and assign only the narrowed result. See
`packages/rfmedia-cli/src/lib/config.ts`.

**Typed enum allowlist**: Enum-like configuration values use a local literal list typed against
the domain union, then throw `ConfigError` with the exact dotted property path on a mismatch. See
the `plex.auth.mode` validation in `packages/rfmedia-cli/src/lib/config.ts`.

**Validator coverage fence**: The Plex validator enumerates handled keys and uses
`Exclude<keyof Interface, HandledKey>` plus a conditional `never` assignment to turn future
validator drift into a typecheck failure. Mirror that pattern immediately after
`validateCopyConfig`.

**Public-boundary tests**: Private configuration validators are exercised through exported
`validateConfig`, with table-driven valid values and exact `ConfigError.propertyPath` assertions.
See `packages/rfmedia-cli/src/lib/config.test.ts`.

**Consumer-specific defaults**: Configuration validation preserves data without applying a
default. The MCP adapters resolve argument, configured value, then `skip`, while the ordinary copy
command retains its existing Commander-driven behavior. Do not widen #302 into precedence or plan
semantics.

## Relevant Docs

**`docs/plans/plex-config-validation-289/shared.md`**: You _must_ read this for the original audit
scope and validator-fence precedent.

**`docs/plans/plex-config-validation-289/analysis-code.md`**: You _must_ read this for exact
`ConfigError` and compile-time coverage patterns.

**`packages/rfmedia-cli/docs/features/conflict-resolution.md`**: You _must_ read this when
checking the existing four strategy semantics; it documents the CLI flag, not a config default.

**`packages/rfmedia-cli/README.md`**: You _must_ read this before changing public config claims.
Current examples omit `copy.conflictStrategy`.

**`CLAUDE.md` and `packages/rfmedia-cli/CLAUDE.md`**: You _must_ read these for strict TypeScript,
ESM import, testing, and command/action boundary rules.
