# Spec: Production-Readiness Lint Command (`rfapps lint`)

## Problem Statement

Operators deploying the 47-service compose stack have no way to catch production-readiness gaps —
missing resource limits, health checks, log rotation, restart policies, security knobs — before they
reach a running host. Today these issues surface as runtime incidents (OOM kills, runaway logs,
silent restarts) rather than as actionable warnings at author or CI time. A `rfapps lint` command
gives operators and CI a fast, deterministic preflight gate so misconfigured services are flagged
with remediation hints before deployment.

## Requirements

### Functional

| #   | Requirement                                                                                              | Priority | Notes                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| F1  | Lint the resolved static compose config (compose.yml + extensions + env) per service, no daemon required | Must     | Default mode; reuses existing compose resolution in `lib/docker.ts` / `lib/config.ts`        |
| F2  | Check for missing/weak: resource limits, health checks, log rotation, restart policy, security knobs     | Must     | Security knobs e.g. `no-new-privileges`, `cap_drop`, `read_only`, non-root user where viable |
| F3  | Each finding carries a `severity` (error / warn / info) and a remediation hint                           | Must     | Remediation hint names the exact compose key/extension anchor to add                         |
| F4  | Optionally inspect running containers for effective runtime settings via `--runtime`                     | Should   | Reports drift between declared compose and live container config; requires Docker daemon     |
| F5  | Scope lint to a service (`-s`), service group (`-g`), or all services (default)                          | Must     | Mirror existing flag conventions from `deploy` / `rebuild`                                   |
| F6  | Emit human-readable grouped table output by default                                                      | Must     | Colorized, grouped by service then severity; matches `status` / `health` style               |
| F7  | Support `--json` machine-readable output                                                                 | Must     | Stable schema for CI pipelines and tooling                                                   |
| F8  | Support `--sarif` output for GitHub code scanning integration                                            | Should   | SARIF 2.1.0; one result per finding with rule id, level, location                            |
| F9  | Configurable `--fail-on <severity>` threshold controlling non-zero exit (default `error`)                | Must     | Findings at or above threshold cause a non-zero exit                                         |
| F10 | Allow per-service / per-rule suppression via `.rfapps.yaml` config                                       | Could    | e.g. a `lint.ignore` map keyed by service or rule id; lets operators waive intentional gaps  |
| F11 | Provide a rule catalog discoverable via `rfapps lint --list-rules`                                       | Could    | Documents each rule id, default severity, and rationale                                      |

### Non-Functional

| #   | Requirement                            | Target                                            | Rationale                                             |
| --- | -------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| NF1 | Static-mode runtime                    | < 1s for the full 47-service stack                | Must be cheap enough to run on every CI push          |
| NF2 | Zero daemon dependency in default mode | No Docker socket access unless `--runtime`        | CI-friendly; runnable in ephemeral/sandboxed contexts |
| NF3 | Deterministic output                   | Identical input → identical findings & ordering   | Stable diffs and reproducible CI gating               |
| NF4 | Type safety                            | No `any`; discriminated unions for findings/rules | Repo convention (CLAUDE.md type-safety rules)         |

## Technical Approach

**Strategy**: Add a `lint` command following the established command → action → lib → types
separation. A pure, daemon-free rule engine in `lib/lint.ts` evaluates the resolved compose config
against a catalog of production-readiness rules, returning typed findings; the action orchestrates
target selection, optional runtime inspection, output formatting, and exit-code resolution.

**Architecture Decisions**:

- Static analysis is the default; runtime inspection is opt-in behind `--runtime` because the
  default path must run without a Docker daemon (NF2).
- Findings use a severity model (error / warn / info) decoupled from exit behavior, with a
  `--fail-on` threshold mapping severity → exit code. This reuses `lib/exit-codes.ts`
  (`ExitCode.Success` / `OperationalError` / `UsageError`) rather than inventing new codes.
- Rules are a declarative catalog (id, severity, predicate, remediation hint) so new checks are
  additive and individually suppressible/testable.
- Output formatting (table / JSON / SARIF) is a thin presentation layer over the same typed finding
  set, mirroring the existing `OutputFormat` pattern from `@rfmedia/common` and `lib/formatters`.

**Key Components**:

- `lib/lint.ts`: rule catalog + pure evaluation engine (compose config → findings); optional
  runtime-drift comparison helper.
- `actions/lint.ts`: target resolution, invokes engine, optional daemon inspection, selects
  formatter, resolves exit code via a new `resolveLintExitCode(findings, failOn)`.
- `types/lint.ts`: `LintRule`, `LintFinding`, `LintSeverity`, `LintResult`, `LintOptions`
  (discriminated unions per repo convention).
- `lib/formatters` additions (or `lib/lint` sub-formatters): table / JSON / SARIF renderers.
- `cli.ts` registration block wiring the `lint` command, flags, and lazy
  `import("./actions/lint.js")`.

## Integration Points

| System/Service                    | Direction | Protocol               | Notes                                                                                                                                |
| --------------------------------- | --------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `cli.ts` command registry         | inbound   | commander `.command()` | Commands are registered inline in `cli.ts` with lazy action import — not a standalone `commands/lint.ts`; follow existing convention |
| `lib/docker.ts` / `lib/config.ts` | outbound  | in-process call        | Source of the resolved compose config (services, extensions, env interpolation)                                                      |
| Docker daemon                     | outbound  | Docker API/CLI         | Only under `--runtime` for live container inspection (drift)                                                                         |
| `lib/exit-codes.ts`               | outbound  | in-process call        | Add `resolveLintExitCode` / `setLintExitCode`; reuse `ExitCode` constants                                                            |
| `.rfapps.yaml`                    | inbound   | YAML config            | Optional `lint.ignore` suppression map (F10)                                                                                         |
| GitHub code scanning              | outbound  | SARIF 2.1.0 file       | `--sarif` output consumed by CI upload step                                                                                          |

## Risks & Unknowns

| Risk                                                                             | Likelihood | Impact | Mitigation                                                                                                     |
| -------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| Compose extension/anchor resolution differs from how rules expect to read config | M          | M      | Lint the same resolved config object the deploy path uses; add fixtures covering extensions                    |
| Over-strict default rules create noise and erode trust in the gate               | M          | M      | Ship conservative defaults; `info`/`warn` for stylistic gaps, `error` only for real risks; suppression via F10 |
| Runtime mode drift checks produce false positives from Docker-applied defaults   | M          | L      | Keep `--runtime` opt-in and clearly labeled; compare only declared keys                                        |
| SARIF schema correctness for GitHub ingestion                                    | L          | M      | Validate against SARIF 2.1.0 schema; add a golden-file test                                                    |

## Open Questions

- [ ] Exact initial rule catalog and each rule's default severity — which checks are `error` vs
      `warn` vs `info` at launch?
- [ ] Should media/GPU services (e.g. `plex`) be exempt from certain resource-limit rules, or
      handled via default suppressions shipped in `.rfapps.yaml`?
- [ ] Does runtime drift detection overlap with the existing `drift` command, and if so should
      `lint --runtime` defer to / reuse `lib/drift.ts` rather than reimplement?
- [ ] Should `--fail-on` also support `none` (report-only) and `info` (strictest) as a complete
      severity ladder?
- [ ] Is a `--list-rules` catalog (F11) in scope for the first pass or a follow-up?

---

_Source: GitHub issue #164 (research/rfapps-new-features — Negative Space: production-readiness
validation)_ _Generated: 2026-06-10T00:35:05Z_ _Status: DRAFT — ready for prp-plan_
