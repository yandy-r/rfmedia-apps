# Spec: Configuration Drift Detection (`rfapps drift`)

## Problem Statement

Operators of the `rfapps` compose platform need to know when the running Docker environment no
longer matches declared compose configuration before drift becomes an outage, failed update, or
confusing support incident. Docker Compose itself is stateless, so day-2 operations need a read-only
drift report that compares declared service state with live containers and is reliable enough for
humans, scripts, MCP clients, and scheduled checks.

## Requirements

### Functional

| #   | Requirement                                                                                                       | Priority | Notes                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Provide a standalone `rfapps drift` command surface for detecting configuration drift                             | Must     | Issue #146 requests dedicated drift detection; current CLI already registers `drift` inline at `packages/rfapps-cli/src/cli.ts:402`                                                                                                                                         |
| F2  | Keep drift detection read-only by default                                                                         | Must     | Default report mode must not mutate containers, compose files, or rfapps state; current `detect` path is read-only at `packages/rfapps-cli/src/actions/drift.ts:430`                                                                                                        |
| F3  | Compare declared compose image, environment, ports, volumes, networks, and selected-service runtime status/health | Must     | Runtime status covers live running/exited/missing state plus Docker health when present; existing drift categories do not include runtime status at `packages/rfapps-cli/src/types/drift.ts:12`                                                                             |
| F4  | Report per-service drift findings with expected value, actual value, category, severity, and summary              | Must     | Existing algorithm compares compose config to container inspect data at `packages/rfapps-cli/src/lib/drift.ts:540`                                                                                                                                                          |
| F5  | Support stable `--json` machine-readable output for automation and MCP consumers                                  | Must     | Shared output formatting exists at `packages/rfapps-cli/src/lib/formatters/index.ts:54`; MCP read tools exist at `packages/rfapps-cli/src/mcp/tools-read.ts:43`                                                                                                             |
| F6  | Provide human-readable output grouped by service and drift category                                               | Must     | Should preserve the current operator-friendly CLI behavior while making runtime-status drift visible                                                                                                                                                                        |
| F7  | Mask likely secret environment values in all human and machine output                                             | Must     | Existing display masking is present at `packages/rfapps-cli/src/actions/drift.ts:118`; JSON output must preserve the same safety invariant                                                                                                                                  |
| F8  | Support service, multi-service, group, compose file, env file, profile, and sidecar-aware targeting               | Must     | Must follow established `rfapps` command conventions so scheduled and interactive runs can scope drift checks safely                                                                                                                                                        |
| F9  | Include external scheduler guidance for cron and systemd timer usage                                              | Must     | Research names lightweight scheduled cron/systemd checks, not a daemon, at `research/rfapps-new-features/synthesis/pattern-recognition.md:101` and `research/rfapps-new-features/persona-findings/analogist.md:82`                                                          |
| F10 | Keep mutating reconciliation/import behavior explicit and separate from default detection                         | Must     | Keep under `rfapps drift`, but document detect/show as default and mark reconcile/import as explicit opt-in; current paths can start services or write compose changes at `packages/rfapps-cli/src/actions/drift.ts:708` and `packages/rfapps-cli/src/actions/drift.ts:868` |
| F11 | Extract drift command registration to `packages/rfapps-cli/src/commands/drift.ts`                                 | Must     | Issue #146 names `commands/drift.ts`; implementation should move drift registration out of inline `cli.ts` while preserving behavior                                                                                                                                        |

### Non-Functional

| #   | Requirement                | Target                                                                                            | Rationale                                                                                        |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| NF1 | Read-only safety           | `rfapps drift` default path performs no Docker mutations and no file writes                       | Drift is an observation command; reconciliation must be explicit                                 |
| NF2 | Stable automation contract | Versioned JSON schema with deterministic ordering and no unmasked secret values                   | MCP clients, cron jobs, CI, and scripts need predictable output                                  |
| NF3 | Runtime practicality       | Full-stack drift detection completes in a practical operator workflow                             | The command may inspect 47 services and should remain usable for scheduled checks                |
| NF4 | Type safety                | Dedicated drift option/result/finding types with strict unions and no `any`                       | Matches TypeScript repo conventions and protects output schema changes                           |
| NF5 | False-positive control     | Compare declared keys intentionally and label Docker-normalized/defaulted values clearly          | Docker inspect output can include runtime defaults that were never declared in compose           |
| NF6 | Documentation completeness | `docs/features/` documents drift categories, JSON contract, exit behavior, and scheduler examples | Roadmap exit criteria require feature docs and JSON support for `drift`                          |
| NF7 | Exit-code contract         | Exit zero when no drift, non-zero on any drift by default, and support a report-only override     | Scheduled checks need alertable failure semantics while humans still need report-only ergonomics |

## Technical Approach

**Strategy**: Treat `rfapps drift` as a standalone diagnostic command that compares resolved compose
declarations with Docker runtime inspection data, then emits one typed drift result through human
and machine formatters. The first implementation focus is completing the read-only detection
contract, especially runtime status/health drift and scheduler-friendly automation output, while
keeping any reconciliation/import behavior clearly opt-in.

**Architecture Decisions**:

- Use resolved compose config as desired state: compare against
  `docker compose config --format json` because that is the existing desired-state source at
  `packages/rfapps-cli/src/lib/docker.ts:722`.
- Use Docker compose/container inspection as actual state: combine service/container mapping from
  `docker compose ps` and `ContainerInspect` fields for image, env, ports, volumes, networks, and
  runtime status.
- Add runtime status as a first-class drift dimension: report selected services that are missing,
  exited, or unhealthy, reuse status parsing concepts from
  `packages/rfapps-cli/src/actions/status.ts:100` and
  `packages/rfapps-cli/src/actions/status.ts:114`, and do not interpret `depends_on` or profile
  membership as runtime drift in v1.
- Keep output data-first and versioned: model drift findings and summaries in typed result objects,
  include `schemaVersion`, add a `runtime-status` category using the existing finding shape, then
  render human text, JSON, YAML, or CSV through the existing formatter contract where possible.
- Preserve secret safety as an invariant: masking should happen consistently for env comparisons
  regardless of output format.
- Prefer scheduler documentation over a daemon: provide cron/systemd examples, default
  non-zero-on-drift behavior, and a report-only override instead of building a resident drift
  monitor.
- Extract command registration for drift: add `commands/drift.ts` as part of this issue and preserve
  current behavior through a dedicated registrar imported by `cli.ts`.

**Key Components**:

- `packages/rfapps-cli/src/commands/drift.ts`: optional command registrar for `rfapps drift`,
  subcommands, flags, examples, and lazy action imports if extraction is accepted.
- `packages/rfapps-cli/src/actions/drift.ts`: orchestrates option resolution, target selection,
  drift detection, read-only safeguards, output selection, and explicit reconcile/import behavior.
- `packages/rfapps-cli/src/lib/drift.ts`: pure comparison logic between resolved compose desired
  state and Docker runtime actual state.
- `packages/rfapps-cli/src/types/drift.ts`: drift categories, runtime-status category, result
  schema, finding schema, summary schema, and command options.
- `packages/rfapps-cli/src/actions/status.ts` or shared status helpers: source of runtime
  state/health parsing reused by drift.
- `packages/rfapps-cli/src/mcp/schema.ts` and `packages/rfapps-cli/src/mcp/tools-read.ts`: expose
  stable read-only drift detection/show schemas to MCP consumers.
- `docs/features/`: operator docs covering drift categories, examples, JSON schema notes, exit
  behavior, and cron/systemd scheduling.

## Integration Points

| System/Service                     | Direction | Protocol              | Notes                                                                                         |
| ---------------------------------- | --------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `rfapps` CLI command registry      | inbound   | Commander command     | Register `rfapps drift` through `commands/drift.ts` while preserving global `--json` behavior |
| Resolved compose configuration     | outbound  | Docker Compose JSON   | Desired state from `docker compose config --format json`                                      |
| Docker runtime containers          | outbound  | Docker CLI/inspect    | Actual image, env, ports, volumes, networks, state, health, and status                        |
| `status` runtime parsing           | outbound  | In-process reuse      | Runtime status/health drift should share existing status interpretation where practical       |
| `@rfmedia/common` output utilities | outbound  | In-process formatting | Keep stdout clean for JSON and deterministic for automation                                   |
| MCP read tools                     | inbound   | MCP tool schema       | Maintain `rfapps.drift.detect` and `rfapps.drift.show` as read-only automation surfaces       |
| External schedulers                | outbound  | cron/systemd examples | Documentation-only integration; no daemon in v1                                               |

## Risks & Unknowns

| Risk                                                                | Likelihood | Impact | Mitigation                                                                                              |
| ------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------- |
| Existing mutating drift subcommands blur the read-only default      | M          | H      | Make detect/show the documented default path and keep reconcile/import explicitly named and opt-in      |
| Runtime status fluctuates during deploys and creates noisy findings | M          | M      | Include timestamp/scope metadata, document expected transient states, and compare against clear targets |
| Docker-normalized inspect data differs from compose declarations    | H          | M      | Compare only meaningful declared fields and add fixtures for common normalization cases                 |
| Environment drift reporting leaks sensitive values in JSON          | M          | H      | Apply secret masking before all renderers and cover JSON output with tests                              |
| Command-module extraction creates churn beyond drift scope          | M          | M      | Treat `commands/drift.ts` extraction as a planning decision and keep behavior-preserving if done        |
| No `lib/state.ts` exists despite issue text naming it               | H          | L      | Use existing `state-storage.ts` / `state-queries.ts` if state integration is needed                     |

## Open Questions

- [x] Should runtime status drift compare against compose `healthcheck`, `depends_on`, desired
      profile membership, or only live running/exited/health state? Decision: compare selected
      services' live running/exited/missing state plus Docker health when present; do not interpret
      `depends_on` or profile membership as runtime drift in v1.
- [x] What exit-code policy should scheduled drift checks use: non-zero on any drift, configurable
      threshold, or always zero unless command execution fails? Decision: exit non-zero on any
      detected drift by default, with a report-only override for interactive or informational runs.
- [x] Should `reconcile` and `import` remain under `rfapps drift`, move to dedicated future
      commands, or be hidden from the v1 drift docs? Decision: keep them under `rfapps drift`, but
      document detect/show as the default read-only path and mark reconcile/import as explicit
      opt-in mutation paths.
- [x] Is command registration extraction to `packages/rfapps-cli/src/commands/drift.ts` required for
      this issue, or should the implementation preserve inline `cli.ts` registration? Decision:
      extract drift registration to `packages/rfapps-cli/src/commands/drift.ts` as part of this
      issue.
- [x] What exact schema version and field names should MCP/JSON consumers rely on for runtime-status
      drift? Decision: add `schemaVersion` and a `runtime-status` category using the existing
      finding shape fields.

---

_Source: GitHub issue #146; user clarifications; `packages/rfapps-cli` pattern inspection;
referenced research docs_ _Generated: 2026-06-10T12:40:00Z_ _Status: COMPLETE — implemented by
`docs/prps/reports/rfapps-drift-report.md`_
