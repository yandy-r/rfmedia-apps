# Documentation Analysis: Copy Conflict Strategy Validation (#302)

## Executive Summary

The public documentation explains the four conflict strategies and the
`--conflict-strategy` CLI option, but it does not document `copy.conflictStrategy` as a
configuration-file setting. The package README, `rfmedia.example.yaml`, and the generated
`rfmedia init` template all omit that key, so they do not falsely promise that the silently dropped
setting already works.

This distinction should be preserved during #302. Retaining the value at validation activates the
existing MCP fallback, but ordinary `rfmedia copy` still derives its strategy from Commander and
does not fall back to `copyConfig.conflictStrategy`. Release notes may promise validated round-trip
and existing direct-consumer behavior; they should not advertise a universal copy-command default
unless CLI precedence is deliberately changed and tested in separate scope.

## Must-Read Documents

### Required

- `docs/plans/plex-config-validation-289/shared.md`: Plan-of-record summary that assigns the
  independently discovered copy-config defect to child issue #302 and establishes the
  presence-preserving validator/fence precedent.
- `docs/plans/plex-config-validation-289/feature-spec.md`: Records the audit disposition and the
  #289 rule that unrelated validator drift is tracked separately.
- `docs/plans/plex-config-validation-289/analysis-code.md`: Most useful implementation precedent
  for exact `ConfigError.propertyPath` tests, handled-key fences, release notes, and roadmap
  closeout.
- `packages/rfmedia-cli/docs/features/conflict-resolution.md`: Canonical behavior guide for
  `skip`, `overwrite`, `rename`, and `ask`; currently documents only the CLI flag and should not
  gain config-default claims that the ordinary CLI does not honor.
- `packages/rfmedia-cli/README.md`: Primary public command/config reference. Its copy config
  examples omit `conflictStrategy`; its MCP section documents only the non-interactive rejection of
  an explicit `ask`.
- `rfmedia.example.yaml`: Copy-paste configuration example. The `copy` block is labeled as copy
  command defaults but does not list `conflictStrategy`.
- `packages/rfmedia-cli/CHANGELOG.md`: Add an `[Unreleased]` fix note scoped to validation and
  retention. Avoid claiming that all CLI copy invocations now consume the configured value.
- `ROADMAP.md`: #302 appears both in the near-term priority table and the open issue inventory.
  Remove it and reconcile surrounding prose only after authoritative completion.
- `docs/roadmap-archive.md`: Shipped-work ledger. Add #302 and its actual closing PR to the
  `rfmedia configuration validation` track after merge.
- `docs/internal/plex-jwt-deferrals.md`: Maintainer record that links #289's resolved audit to the
  still-open #302 follow-up. Mark only the #302 entry resolved after merge.

### Supporting

- `docs/plans/plex-config-validation-289/analysis-context.md`: Explains why the copy finding was
  excluded from #289 and identifies #302 as its sole owner.
- `docs/plans/plex-config-validation-289/research-technical.md`: Repository-wide interface-to-
  validator audit evidence and the original separate-issue recommendation.
- `docs/README.md`: Documentation index; no new entry is needed unless a new standalone guide is
  created.
- `.github/pull_request_template.md`: Required handoff structure for exact validation commands and
  outcomes.

## Architecture Docs

- No root `docs/architecture/` update is required. This is an in-process validation-boundary fix
  with no service, container, network, database, or API topology change.
- `packages/rfmedia-cli/docs/features/config-validation-caching.md` accurately shows parsing and
  schema validation in the `loadConfig()` pipeline. The cache architecture does not change, so a
  feature-specific edit would add noise.
- `packages/rfmedia-cli/docs/features/conflict-resolution.md` remains the authoritative strategy
  semantics document. It may receive a narrow configuration note only if the shipped consumer
  contract is stated precisely: MCP copy tools can use a retained configured strategy, while the
  ordinary CLI remains flag-driven in #302's current scope.
- The Bash, Zsh, and Fish completion templates already expose the same four CLI values. No
  completion guide or parity documentation change is required because #302 adds no command, flag,
  or choice.

## Reading List

1. Read `shared.md`, `feature-spec.md`, and `analysis-code.md` under
   `docs/plans/plex-config-validation-289/` to preserve the audit scope and copy the established
   validator-fence documentation pattern.
2. Read `conflict-resolution.md` alongside the copy and MCP sections of the package README to
   separate strategy semantics, explicit tool arguments, and configuration fallback behavior.
3. Compare the three user-facing config examples: `rfmedia.example.yaml`, the README's
   `Config File Format (YAML)` block, and `buildConfigTemplate()` in
   `packages/rfmedia-cli/src/lib/config.ts`.
4. Verify actual consumption before writing release prose:
   `packages/rfmedia-cli/src/mcp/adapters.ts` uses
   `args.conflictStrategy ?? copyConfig.conflictStrategy ?? "skip"`, while
   `packages/rfmedia-cli/src/commands/copy.ts` currently returns only the validated Commander
   option.
5. At closeout, update the changelog first, then remove #302 from both live ROADMAP locations,
   archive it with the real PR, and resolve its maintainer deferral entry.

## Documentation Gaps

- The repository has no public configuration reference that names
  `copy.conflictStrategy`, its exact four accepted literals, omission behavior, or invalid-value
  error path.
- `rfmedia init` is described as generating a template with all available options, but
  `buildConfigTemplate()` omits `conflictStrategy`; `rfmedia.example.yaml` and the README's complete
  YAML sample omit it as well.
- Adding the key to those examples during #302 would imply ordinary CLI default behavior that the
  current implementation does not provide. Either leave the examples unchanged and document only
  validation/MCP retention, or separately implement and test CLI precedence before presenting it
  as a copy-command default.
- No user-facing document explains that `ask` is valid configuration data at the validation
  boundary but is rejected later by non-interactive MCP execution. If configured MCP behavior is
  documented, keep this execution-context distinction explicit.
- The #289 plan artifacts are historical evidence and should not be rewritten. Closure belongs in
  the changelog, live ROADMAP, roadmap archive, and internal deferral ledger.
- No docs index, new standalone feature page, architecture diagram, or shell-completion update is
  warranted for the validator-only repair.
