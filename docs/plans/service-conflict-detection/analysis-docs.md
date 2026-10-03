# Documentation Analysis: service-conflict-detection

## Executive Summary

`service-conflict-detection` needs one new canonical user guide plus coordinated updates across the
rfapps command reference, dry-run/output/error documentation, architecture flow, completion guide,
documentation index, quick reference, troubleshooting, and roadmap. The feature is not complete if
only Commander help changes: `--validate-first` changes what dry-run can inspect, introduces a
versioned nested machine result, rejects CSV in v1, adds `blocked` and `inconclusive` operational
outcomes, and guarantees no Docker mutation or deployment-history write on preflight failure.

The canonical new page should be `docs/features/service-conflict-detection.md`. It must explain:

- the opt-in command and exact placement before confirmation, pull, start, readiness, and state
  writes;
- Docker-owned fixed-port, objective volume-definition, and explicit-subnet coverage;
- effective scope after groups, sidecars, profiles, and Compose dependencies;
- `passed`, `blocked`, and `inconclusive` outcomes and exit codes;
- inert manual suggestions and the fact that `--yes` is not a safety override;
- JSON/YAML nested evidence, human output, and v1 CSV rejection;
- point-in-time and remote-context limitations;
- no automatic remediation, non-Docker listener scan, volume-compatibility inference, or
  persistence.

Several existing documents contain statements that become false without an explicit
`--validate-first` exception. In particular, `docs/features/dry-run-mode.md` currently says dry-run
executes no Docker commands and cannot detect runtime port conflicts; the new option performs fresh
read-only Compose/Engine inspection during dry-run. `docs/features/output-formats.md` presents CSV
as generally available, but the feature spec rejects `--output csv --validate-first`. And
`docs/features/error-handling.md` says validation errors in machine mode leave stdout empty, while
a valid preflight that becomes `blocked` or `inconclusive` must emit one structured deploy result.

No new HTTP, MCP, configuration, database, or plan/apply documentation surface is introduced in
v1. Existing MCP is stdio and remains unchanged. Conflict results are ephemeral and must not be
described as deployment history, a saved plan, or a resource reservation.

## Must-Read Documents

### Authoritative feature documents

| Priority | Document                                                            | Why it is required                                                                                                   |
| -------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| P0       | `docs/plans/service-conflict-detection/feature-spec.md`             | Source of truth for scope, conflict rules, CLI/output contract, statuses, persistence boundary, and success criteria |
| P0       | `docs/plans/service-conflict-detection/analysis-architecture.md`    | Module ownership, dependency direction, gate placement, and planned file boundaries                                  |
| P0       | `docs/plans/service-conflict-detection/analysis-integration.md`     | Docker Compose/Engine, authority, configuration, output, database, MCP, and entrypoint seams                         |
| P0       | `docs/plans/service-conflict-detection/analysis-patterns.md`        | Repository patterns to reuse and anti-patterns to avoid                                                              |
| P0       | `docs/plans/service-conflict-detection/research-business.md`        | Operator/automation rules, effective scope, objective conflicts, and workflow semantics                              |
| P0       | `docs/plans/service-conflict-detection/research-security.md`        | Authority/input race, secret handling, output bounds, remote Docker, and non-executable remediation requirements     |
| P1       | `docs/plans/service-conflict-detection/research-technical.md`       | Detailed data models, Docker seams, deterministic ordering, tests, and proposed code changes                         |
| P1       | `docs/plans/service-conflict-detection/research-external.md`        | Docker-documented semantics and explicit coverage limits                                                             |
| P1       | `docs/plans/service-conflict-detection/research-ux.md`              | Human wording, non-TTY behavior, ranked manual suggestions, and accessible presentation                              |
| P2       | `docs/plans/service-conflict-detection/research-practices.md`       | Engineering/testing practices and dependency posture                                                                 |
| P2       | `docs/plans/service-conflict-detection/research-recommendations.md` | Synthesized sequencing and acceptance recommendations                                                                |

### Current public contracts

| Priority | Document                                | What to extract before editing                                                                                                  |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| P0       | `packages/rfapps-cli/README.md`         | Canonical deploy syntax/options, state locking, outputs, exit codes, examples, configuration, and package-level discoverability |
| P0       | `docs/features/dry-run-mode.md`         | Existing no-mutation promise, current claimed validations, JSON examples, and outdated runtime-conflict limitations             |
| P0       | `docs/features/output-formats.md`       | Global text/table/JSON/YAML/CSV rules, stdout/stderr behavior, and flag precedence                                              |
| P0       | `docs/features/json-output.md`          | Existing `DeployResult` example and automation guidance                                                                         |
| P0       | `docs/features/error-handling.md`       | Exit categories, machine error behavior, operational-versus-usage validation, and actionable guidance style                     |
| P0       | `docs/features/shell-completion.md`     | Bash/Zsh/Fish contract and the expectation that generated completions match registered options                                  |
| P1       | `docs/features/interactive-cli.md`      | TTY/non-TTY selection and confirmation behavior; useful for explaining why suggestions are display-only                         |
| P1       | `docs/features/rfapps-configuration.md` | Configuration precedence, static Compose-reference validation, and the fact that no conflict-policy key exists                  |
| P1       | `docs/features/secrets-management.md`   | dotenvx/1Password behavior and the promise that resolved secret values are not logged                                           |
| P1       | `docs/features/deployment-history.md`   | Existing SQLite/history contract that preflight must remain outside                                                             |
| P1       | `docs/features/quick-reference.md`      | One-page operator commands and safety examples                                                                                  |
| P1       | `docs/guides/troubleshooting.md`        | Existing diagnostic patterns and the destination for conflict/inconclusive recovery                                             |
| P1       | `docs/README.md`                        | Repository documentation index where the new feature page must be linked                                                        |
| P1       | `README.md`                             | Root-level command/option discoverability and feature-documentation links                                                       |
| P1       | `ROADMAP.md`                            | Two live #64 entries that must move consistently when the issue ships                                                           |
| P1       | `docs/roadmap-archive.md`               | Shipped lifecycle history and operator note destination                                                                         |

### Maintainer contracts

| Priority | Document                                | Relevance                                                                                                       |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| P1       | `packages/rfapps-cli/CLAUDE.md`         | Package structure, command/action/lib split, SQLite boundary, output conventions, tests, and error architecture |
| P1       | `CLAUDE.md`                             | Repository-wide CLI, docs, completion, testing, and roadmap expectations                                        |
| P2       | `.github/pull_request_template.md`      | Required PR sections and exact validation-command reporting                                                     |
| P2       | `docs/templates/github/pull-request.md` | Offline drafting mirror only; GitHub template remains authoritative                                             |

## Architecture Docs

### Required architecture updates

#### `docs/architecture/data-flow.md`

This is the primary architecture document that must change. Its current `rfapps Deploy Flow`
sequence goes from scope expansion directly to pull/start. Add:

1. resolved Compose capture and effective dependency closure;
2. bounded container/network/volume observation under the active Docker authority;
3. pure conflict evaluation;
4. a `passed` branch into current dry-run/confirmation/deploy behavior; and
5. `blocked`/`inconclusive` branches that render and exit `1` without mutation or persistence.

The diagram and prose must label the preflight as point-in-time evidence, not a reservation. It
must also show that the one gate sits above both parallel and sequential deploy branches.

#### `docs/architecture/overview.md`

Update the rfapps package architecture with the new pure evaluator and bounded Docker evidence
adapter. If `ipaddr.js` is added, include it in the rfapps dependency list/diagram. Document the
same layering used by the implementation:

```text
Commander deploy option
  -> deploy action orchestration
  -> Docker/Compose evidence adapters
  -> pure conflict evaluator
  -> versioned result / existing deploy
```

Do not describe this as a new service, daemon, HTTP endpoint, or infrastructure component.

#### `packages/rfapps-cli/CLAUDE.md`

This maintainer architecture guide should gain:

- `src/lib/conflict-validation.ts` and `src/types/validation.ts` in the project structure;
- the preflight gate in the deploy architecture;
- the optional `DeployResult.validation` contract;
- the no-persistence/no-remediation boundary; and
- the focused tests and completion parity expectation.

This update is internal documentation, not a substitute for the public feature page.

### Architecture documents that should remain unchanged

- `docs/reference/architecture-diagram.md` describes deployed service/network topology. The
  validator adds no container or network, so no feature-specific diagram belongs there.
- `docs/features/plan-apply-workflow.md` documents persisted plans. V1 conflict validation is a
  same-process preflight and does not save or apply a plan.
- `docs/features/rfapps-reconcile-command.md` documents report/auto-apply convergence. Conflict
  validation may reuse identity patterns but does not reconcile or mutate.
- `docs/features/rfapps-mcp-server.md` documents the stdio MCP surface. V1 intentionally does not
  add `validateFirst` to the MCP deploy schema.
- `docs/features/deployment-rollback.md` is unaffected because a failed preflight creates no
  deployment or rollback anchor.

### Architecture cross-links

The new `docs/features/service-conflict-detection.md` should link to:

- `docs/features/dry-run-mode.md`;
- `docs/features/output-formats.md`;
- `docs/features/error-handling.md`;
- `docs/features/rfapps-configuration.md`;
- `docs/features/secrets-management.md`;
- `docs/features/deployment-history.md`; and
- `packages/rfapps-cli/README.md#deploy`.

Reciprocal links should be added where a reader could otherwise miss the scoped exception or
feature contract.

## Reading List

### P0: Required before implementation

1. `docs/plans/service-conflict-detection/feature-spec.md`
2. `docs/plans/service-conflict-detection/analysis-architecture.md`
3. `docs/plans/service-conflict-detection/analysis-integration.md`
4. `docs/plans/service-conflict-detection/analysis-patterns.md`
5. `docs/plans/service-conflict-detection/research-security.md`
6. `packages/rfapps-cli/README.md`, especially state locking and `deploy`
7. `docs/architecture/data-flow.md`, especially `rfapps Deploy Flow`
8. `docs/features/dry-run-mode.md`
9. `docs/features/output-formats.md`
10. `docs/features/error-handling.md`

This order establishes the normative feature contract first, then repository layering and current
public behavior. It prevents implementation details from silently redefining product semantics.

### P0: Documentation required for release

#### Create

- `docs/features/service-conflict-detection.md`

Minimum sections:

1. overview and quick start;
2. gate placement and no-mutation guarantee;
3. effective scope;
4. port, volume, and network rules;
5. `passed`/`blocked`/`inconclusive` statuses;
6. human examples with inert ranked suggestions;
7. complete, valid JSON/YAML example and field reference for `conflict-validation.v1`;
8. exit codes and `--yes`/`--allow-partial`/dry-run interactions;
9. remote-context, point-in-time, host-network, non-Docker listener, dynamic-allocation, and
   third-party-driver limitations;
10. troubleshooting and safe rerun workflow;
11. security/privacy note covering resolved secrets, host bind paths, and sanitized output; and
12. related documentation links.

#### Update

- `packages/rfapps-cli/README.md`
  - add the feature to the overview;
  - add `--validate-first` to the deploy option table;
  - add pass, desired-conflict, runtime-conflict, inconclusive, dry-run, `--yes`, and machine-mode
    examples;
  - document exit `1` and why `--allow-partial` does not apply;
  - show the nested optional validation result and CSV rejection;
  - link to the full feature guide.
- `docs/README.md`
  - add the new page under CLI features.
- `docs/architecture/data-flow.md`
  - update the deploy sequence and persistence boundary.
- `docs/architecture/overview.md`
  - add the evaluator/adapter boundary and dependency if selected.
- `docs/features/dry-run-mode.md`
  - explain that `--validate-first` intentionally executes read-only Docker inspection;
  - replace the blanket "cannot detect port conflicts" statement with exact Docker-owned coverage;
  - document `--dry-run --validate-first` exits and structured evidence.
- `docs/features/output-formats.md`
  - document nested JSON/YAML validation;
  - document human text/table projection;
  - document v1 CSV rejection and one-document stdout.
- `docs/features/json-output.md`
  - replace or augment the deploy example with a valid validation result;
  - document stable IDs/codes/order and `.validation.status` automation.
- `docs/features/error-handling.md`
  - add preflight operational outcomes;
  - distinguish invalid usage (exit `2`, possibly no result) from valid but blocked/inconclusive
    validation (exit `1`, one result in machine mode);
  - state that raw Docker/Compose stderr is not the machine contract.
- `docs/features/shell-completion.md`
  - add deploy completion behavior for `--validate-first`;
  - record exact Bash/Zsh/Fish parity and the concurrent `--allow-partial` parity correction.
- `docs/features/quick-reference.md`
  - add safe deploy examples and compact exit/coverage guidance.
- `docs/guides/troubleshooting.md`
  - add recovery for desired conflict, external runtime owner, inconclusive Docker access/output,
    invalid CIDR, and point-in-time race;
  - never suggest automatic volume deletion.
- `docs/features/deployment-history.md`
  - add a short boundary note that preflight-only failures create no deployment or generation row.
- `packages/rfapps-cli/CLAUDE.md`
  - update package structure and feature boundaries.
- `README.md`
  - add the flag to common deploy options or management examples and link the feature page.
- `ROADMAP.md`
  - remove/mark both #64 live entries consistently when shipped.
- `docs/roadmap-archive.md`
  - add #64 to shipped lifecycle work with closing PR and an operator note.

### P1: Recommended consistency updates

- `docs/features/rfapps-configuration.md`
  - explicitly state that conflict validation is per invocation and adds no configuration key;
  - distinguish existing static configuration-reference validation from runtime conflict
    validation.
- `docs/features/secrets-management.md`
  - cross-link the feature and state that canonical Compose resolution remains ephemeral and
    redacted.
- `docs/features/interactive-cli.md`
  - clarify that numbered conflict resolutions are display-only; they are not selectable actions
    and `--yes` never executes them.
- `.github/pull_request_template.md`
  - use unchanged as the PR body baseline and include exact docs/test/audit commands under
    `## Testing`; no template content change is required.

### P2: Explicitly deferred

- `docs/features/rfapps-mcp-server.md`: update only when conflict validation is intentionally added
  to MCP.
- `docs/features/plan-apply-workflow.md`: update only if a future release persists a conflict plan.
- `docs/features/rfapps-reconcile-command.md`: update only if validation becomes a shared
  reconciliation policy.
- `docs/reference/architecture-diagram.md`: update only if the infrastructure topology changes.

## Documentation Gaps

| Severity    | Current gap                                                                                   | Affected documents                                                   | Required resolution                                                                              |
| ----------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Required    | No canonical user-facing feature guide exists                                                 | `docs/features/`                                                     | Create `docs/features/service-conflict-detection.md` and index it                                |
| Required    | Deploy reference has no flag, conflict rules, outcomes, or examples                           | `packages/rfapps-cli/README.md`                                      | Add complete deploy contract and link the canonical guide                                        |
| Required    | Dry-run claims no Docker commands run and runtime port conflicts cannot be detected           | `docs/features/dry-run-mode.md`                                      | Add a scoped read-only `--validate-first` exception and exact limitations                        |
| Required    | Output docs imply CSV works for every command/result                                          | `docs/features/output-formats.md`                                    | Document `--output csv --validate-first` usage rejection in v1                                   |
| Required    | JSON deploy example lacks validation evidence and contains questionable empty service entries | `docs/features/json-output.md`                                       | Add a valid versioned example and stable automation queries                                      |
| Required    | Error docs say validation failures in machine mode leave stdout empty                         | `docs/features/error-handling.md`                                    | Distinguish pre-action usage validation from a valid preflight result that blocks operationally  |
| Required    | Deploy data-flow jumps directly from scope resolution to pull/start                           | `docs/architecture/data-flow.md`                                     | Add desired/runtime observation, evaluator, pass/block branches, and no-persistence boundary     |
| Required    | Package architecture omits the evaluator and CIDR dependency                                  | `docs/architecture/overview.md`, `packages/rfapps-cli/CLAUDE.md`     | Add new modules, dependency direction, and read-only gate                                        |
| Required    | Completion docs do not mention the new deploy flag or current `--allow-partial` drift         | `docs/features/shell-completion.md`                                  | Document exact Commander/Bash/Zsh/Fish parity                                                    |
| Required    | Operators have no concise conflict or inconclusive recovery steps                             | `docs/features/quick-reference.md`, `docs/guides/troubleshooting.md` | Add manual repair/rerun guidance and remote-context diagnostics                                  |
| Required    | Readers may assume failed validation is stored in deployment history                          | `docs/features/deployment-history.md`, new feature guide             | State explicitly that no SQLite or generation write occurs                                       |
| Required    | Documentation index does not expose the feature                                               | `docs/README.md`, `README.md`                                        | Add discoverable links and a common command example                                              |
| Required    | #64 remains live in two roadmap locations                                                     | `ROADMAP.md`                                                         | Reconcile both entries on ship and add archive history                                           |
| Required    | Remote-context coverage can be mistaken for the local host                                    | New feature guide, troubleshooting                                   | Explain active Docker authority, no local `lsof`/host-route claim, and Docker as final allocator |
| Required    | Suggestions could be read as auto-remediation                                                 | New feature guide, interactive docs                                  | Label every resolution manual/inert; explain `--yes` is not authorization                        |
| Required    | Volume sharing could be documented too broadly as a conflict                                  | New feature guide                                                    | List permitted shared-volume cases and objective blocking predicates                             |
| Required    | Scope could be described as only explicitly selected services                                 | New feature guide, deploy reference                                  | Explain groups, sidecars, profiles, transitive dependencies, and concrete untargeted scope       |
| Recommended | Static config validation and runtime conflict validation share the word "validation"          | `docs/features/rfapps-configuration.md`                              | Name and contrast both checks to prevent operator confusion                                      |
| Recommended | Secrets docs do not cover ephemeral resolved Compose inspection                               | `docs/features/secrets-management.md`                                | Add a privacy cross-link without exposing implementation payloads                                |
| Deferred    | Existing MCP deploy could appear to inherit the CLI flag automatically                        | `docs/features/rfapps-mcp-server.md`                                 | State in the feature guide that v1 is CLI-only; change MCP docs only when its schema changes     |
| Deferred    | Users may expect a reusable saved conflict plan                                               | `docs/features/plan-apply-workflow.md`                               | State in the feature guide that validation is same-process and ephemeral                         |

Documentation examples must use real service names, omit secret values and absolute host bind
paths, show complete arrays rather than unexplained placeholders, and remain deterministic. The
release PR should run the repository Markdown formatter/linter and record the exact commands and
outcomes in `.github/pull_request_template.md`.
