# Service Conflict Detection

`rfapps deploy --validate-first` adds one opt-in, fail-closed preflight to the existing deploy
action. After static configuration and requested/group/sidecar/profile selection, rfapps resolves
the canonical Compose model, expands the concrete transitive service scope, collects bounded
read-only Docker evidence, and passes narrow projections to a pure deterministic evaluator. The
gate runs before dry-run returns, confirmation, pull/start, readiness, SQLite initialization, or
state writes; only `passed` continues, while `blocked` and `inconclusive` emit a versioned result
and exit `1`.

## Relevant Files

- `packages/rfapps-cli/src/cli.ts`: Registers deploy options and the non-dry-run state lock.
- `packages/rfapps-cli/src/actions/deploy.ts`: Owns the single pre-mutation validation gate.
- `packages/rfapps-cli/src/actions/deploy.spec.ts`: Verifies gate ordering, exits, and modes.
- `packages/rfapps-cli/src/types/options.ts`: Defines normalized deploy options.
- `packages/rfapps-cli/src/types/results.ts`: Defines the deploy result envelope.
- `packages/rfapps-cli/src/types/index.ts`: Exports stable public validation contracts.
- `packages/rfapps-cli/src/lib/docker.ts`: Resolves Compose and observes Docker resources.
- `packages/rfapps-cli/src/lib/docker.spec.ts`: Verifies strict bounded evidence collection.
- `packages/rfapps-cli/src/lib/dependency-graph.ts`: Hosts effective transitive service closure.
- `packages/rfapps-cli/src/lib/dependency-graph.spec.ts`: Covers closure failures and ordering.
- `packages/rfapps-cli/src/lib/security-audit.ts`: Pure deterministic evaluator precedent.
- `packages/rfapps-cli/src/lib/identity.ts`: Canonical Compose and Docker authority identity.
- `packages/rfapps-cli/src/lib/env-tools.ts`: Captures the effective execution environment.
- `packages/rfapps-cli/src/lib/formatters/index.ts`: Emits one machine-output document.
- `packages/rfapps-cli/src/lib/exit-codes.ts`: Preserves stable exit-code categories.
- `packages/rfapps-cli/src/actions/completion.ts`: Generates Bash, Zsh, and Fish completions.
- `packages/rfapps-cli/src/actions/completion.spec.ts`: Enforces exact completion parity.
- `packages/rfapps-cli/src/testing/mock-docker.ts`: Builds typed fake-Docker responses.
- `packages/rfapps-cli/src/testing/deploy-scenarios.ts`: Composes CLI integration scenarios.
- `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`: Proves real-process mutation bounds.
- `packages/rfapps-cli/package.json`: Declares the narrow IPv4/IPv6 CIDR dependency.
- `package-lock.json`: Records the reviewed dependency resolution.
- `packages/rfapps-cli/README.md`: Documents the package-level operator contract.
- `ROADMAP.md`: Tracks issue #64 in the active roadmap.
- `docs/roadmap-archive.md`: Records shipped roadmap work.

## Relevant Patterns

**Command/action/library layering**: Commander registers the flag, `executeDeploy()` orchestrates
the gate, and a side-effect-free library evaluates typed evidence. See
[`packages/rfapps-cli/src/cli.ts`](packages/rfapps-cli/src/cli.ts),
[`packages/rfapps-cli/src/actions/deploy.ts`](packages/rfapps-cli/src/actions/deploy.ts), and
[`packages/rfapps-cli/src/lib/security-audit.ts`](packages/rfapps-cli/src/lib/security-audit.ts).

**Fail-closed Docker boundary**: External JSON is parsed as `unknown`, bounded, projected to
allowlisted fields, and rejected on partial or malformed evidence. Follow
[`packages/rfapps-cli/src/lib/docker.ts`](packages/rfapps-cli/src/lib/docker.ts) hardened
observation and argument-array execution patterns without reusing its permissive fallbacks as
safety evidence.

**Deterministic results as data**: Stable schema constants, discriminated unions, explicit
code-point sorting, and one formatter path keep human and machine views aligned. See
[`packages/rfapps-cli/src/types/audit.ts`](packages/rfapps-cli/src/types/audit.ts) and
[`packages/rfapps-cli/src/lib/formatters/index.ts`](packages/rfapps-cli/src/lib/formatters/index.ts).

**Risk-owned tests**: Pure rules, Docker parsing, deploy orchestration, subprocess mutation
boundaries, and completion parity each have one focused test layer. Reuse
[`packages/rfapps-cli/src/testing/cli-harness.ts`](packages/rfapps-cli/src/testing/cli-harness.ts)
for real CLI behavior instead of importing the module-loading entrypoint.

**Ephemeral validation**: Conflict evidence is never cached or persisted. Existing deployment
history remains downstream of successful mutation; see
[`packages/rfapps-cli/src/lib/state-storage.ts`](packages/rfapps-cli/src/lib/state-storage.ts).

## Relevant Docs

**`docs/plans/service-conflict-detection/feature-spec.md`**: You _must_ read this for the approved
scope, statuses, conflict rules, output contract, limitations, and acceptance criteria.

**`docs/plans/service-conflict-detection/analysis-architecture.md`**: You _must_ read this for
module ownership, data flow, authority binding, and the pre-mutation gate.

**`docs/plans/service-conflict-detection/analysis-patterns.md`**: You _must_ read this for
TypeScript, error/output, Docker parsing, completion, and testing conventions.

**`docs/plans/service-conflict-detection/analysis-integration.md`**: You _must_ read this for
Compose/Engine evidence, environment/authority, persistence, MCP, and output boundaries.

**`packages/rfapps-cli/CLAUDE.md`**: You _must_ read this for package architecture, ESM imports,
strict typing, exit codes, logging, and test commands.

**`packages/rfapps-cli/README.md`**: You _must_ read this when changing deploy behavior and its
public option/result contract.

**`docs/features/dry-run-mode.md`**: You _must_ read this when documenting the scoped read-only
Docker inspection exception.

**`docs/features/output-formats.md`**: You _must_ read this for one-document JSON/YAML behavior
and the v1 CSV rejection.

**`docs/features/error-handling.md`**: You _must_ read this for usage, operational, and partial
exit semantics.

**`docs/features/shell-completion.md`**: You _must_ read this when restoring exact
Commander/Bash/Zsh/Fish deploy parity.
