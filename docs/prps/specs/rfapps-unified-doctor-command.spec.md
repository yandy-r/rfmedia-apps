# Spec: Unified Doctor Command (`rfapps doctor`)

## Problem Statement

Operators of the `rfapps` platform currently need to combine multiple commands and manual checks to
understand deployment health, image freshness, configuration hygiene, security posture, and
persisted state. This makes recurring operational issues harder to diagnose, slows post-Watchtower
replacement workflows, and leaves no single read-only diagnostic surface for humans or automation.

## Requirements

### Functional

| #   | Requirement                                                                                         | Priority | Notes                                                                                             |
| --- | --------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| F1  | Provide a `rfapps doctor` command that aggregates operational, security, and configuration findings | Must     | Covers image freshness, config hygiene, security posture, and state health from issue #144        |
| F2  | Keep doctor read-only by default                                                                    | Must     | The command may inspect compose config, Docker state, registry metadata, and rfapps state only    |
| F3  | Support human-readable output grouped by severity, category, and affected service                   | Must     | Should feel consistent with existing `status`, `plan`, `health`, `drift`, and `lint` displays     |
| F4  | Support `--json` machine output with a stable schema                                                | Must     | Schema stability is a first-implementation must-have and should be represented in typed contracts |
| F5  | Return actionable findings with severity and suggested next command                                 | Must     | Example next commands may reference existing `plan`, `status`, `health`, `drift`, or `lint` flows |
| F6  | Reuse existing service targeting and config override behavior                                       | Should   | Follow `-s`, `--services`, `-g`, `--no-sidecars`, `-f`, `-e`, and `-p` conventions where relevant |
| F7  | Integrate with existing `plan` and `status` behavior rather than acting as an isolated diagnostic   | Should   | Image freshness and status-style health should reuse or compose existing behavior where practical |
| F8  | Run core fast diagnostics by default and make registry image freshness opt-in via `--check-updates` | Must     | Mirrors `plan --check-updates` and avoids slow or flaky network access in default doctor runs     |
| F9  | Support a configurable failure threshold with a critical-only non-zero default                      | Must     | Findings are diagnostic, but automation needs a stable way to fail on severe platform risks       |

### Non-Functional

| #   | Requirement             | Target                                                                               | Rationale                                                                   |
| --- | ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| NF1 | Stable JSON contract    | Versioned top-level schema and typed result set                                      | Automation and future PRP planning depend on predictable machine output     |
| NF2 | Read-only safety        | No container mutation, config writes, or state writes by default                     | Doctor is diagnostic, not remedial                                          |
| NF3 | Deterministic reporting | Stable finding IDs, ordering, severity taxonomy, and categories                      | Reduces noisy diffs and makes CI or scripted use reliable                   |
| NF4 | Type safety             | Dedicated doctor option/result/finding types with no `any`                           | Matches repo conventions for TypeScript CLI contracts                       |
| NF5 | Bounded runtime         | Full-stack diagnostics complete in a practical operator workflow                     | Avoid turning a high-level doctor check into an unexpectedly long operation |
| NF6 | Output compatibility    | Honor global `--output <format>` where practical and keep `--json` as a legacy alias | Matches current CLI output behavior and keeps scripting ergonomic           |

## Technical Approach

**Strategy**: Add `rfapps doctor` as an orchestration layer over focused diagnostic checkers, not as
a parallel implementation of existing commands. The action should load the resolved rfapps
configuration, resolve target services using established service-selection behavior, run read-only
checkers, then emit one typed `DoctorResult` through human and JSON formatters.

**Architecture Decisions**:

- Reuse existing diagnostics where practical: leverage plan-style image freshness checks,
  status/health-style runtime state, drift/lint-style comparison and configuration findings, and
  state query helpers so doctor remains a unifying surface.
- Make the JSON schema explicit and versioned: include a schema version, timestamp, target scope,
  checks run/skipped, summary, findings, and optional telemetry availability so scripts can rely on
  stable fields.
- Model findings as data: use stable IDs, severity, category, affected service, evidence, message,
  and suggested next command so output rendering stays separate from diagnostic logic.
- Keep remediation outside v1: suggested commands should point operators toward existing rfapps
  workflows without executing fixes.
- Keep network-dependent image freshness checks opt-in: reuse the `plan --check-updates` mental
  model so default doctor runs stay fast and local.
- Match the current global output contract: support human text by default, stable JSON through
  `--json` or `--output json`, and other global `--output` formats where the shared formatter
  supports the result shape.
- Register through a dedicated command module: add `commands/doctor.ts` for command definition while
  preserving lazy import of `actions/doctor.ts`.

**Key Components**:

- `packages/rfapps-cli/src/commands/doctor.ts`: command definition, doctor-specific options, help
  text, and lazy action import registration.
- `packages/rfapps-cli/src/actions/doctor.ts`: command action that resolves options, invokes
  diagnostic checks, handles output, and sets threshold-based exit behavior.
- `packages/rfapps-cli/src/lib/doctor/`: checker registry, shared result aggregation, severity
  sorting, and human/JSON formatting helpers.
- `packages/rfapps-cli/src/types/doctor.ts`: `DoctorResult`, `DoctorFinding`, severity/category
  unions, schema version, and command option types.
- `packages/rfapps-cli/src/cli.ts`: imports and invokes `registerDoctorCommand(program)` from the
  dedicated command module.

## Integration Points

| System/Service                       | Direction | Protocol               | Notes                                                                                                                 |
| ------------------------------------ | --------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `rfapps` command registry            | inbound   | Commander command      | Register `doctor` via `commands/doctor.ts` with existing global `--json` / `--output` behavior and lazy action import |
| `lib/config.ts` / service resolution | outbound  | In-process call        | Load layered config, apply compose/env/profile overrides, and resolve targeted services                               |
| `plan` image/update logic            | outbound  | In-process call        | Reuse or adapt image freshness behavior only when `--check-updates` is passed, without creating or applying plans     |
| `status` / `health` diagnostics      | outbound  | Docker CLI via helpers | Inspect current service state and dependency readiness without mutating containers                                    |
| `drift` / `lint` diagnostics         | outbound  | In-process call        | Incorporate configuration hygiene and drift-style signals where existing checks fit                                   |
| rfapps state storage/query helpers   | outbound  | SQLite read/query      | Inspect state health read-only; no doctor writes by default                                                           |
| `@rfmedia/common` output utilities   | outbound  | In-process call        | Preserve stdout cleanliness for JSON, honor global `--output` where practical, and use stderr for human/log output    |

## Risks & Unknowns

| Risk                                                                        | Likelihood | Impact | Mitigation                                                                                           |
| --------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------- |
| Doctor duplicates logic from `plan`, `status`, `health`, `drift`, or `lint` | M          | H      | Treat doctor as an aggregator and define shared checker boundaries during planning                   |
| Stable JSON schema is chosen too early and later blocks useful diagnostics  | M          | H      | Version the schema from v1 and keep extensible fields for categories, evidence, and signals          |
| Full-stack checks become slow because runtime inspection is expensive       | M          | M      | Keep default checks bounded, make registry image freshness opt-in, and report telemetry availability |
| Severity taxonomy is inconsistent with existing lint/health concepts        | M          | M      | Define a small doctor severity union and map existing signals into it consistently                   |
| Suggested next commands become stale or unsafe                              | L          | M      | Use only existing read-only or explicit operator commands and cover command suggestions in tests     |

## Open Questions

- [x] Should `doctor` support command-specific flags to include or exclude diagnostic categories in
      v1, or should all categories always run? Decision: run core fast checks by default; do not add
      broad category include/exclude flags in v1; use `--check-updates` for registry image
      freshness.
- [x] What exit-code policy should findings use: always zero for diagnostics, non-zero for critical
      findings, or configurable threshold? Decision: support a configurable threshold with a
      critical-only non-zero default.
- [x] Should image freshness checks run by default if registry access may slow or fail the command?
      Decision: no; registry image freshness is opt-in via `--check-updates`, mirroring `plan`.
- [x] Should `doctor` reuse `--output <format>` beyond `--json`, or is human text plus legacy
      `--json` enough for v1? Decision: honor global `--output <format>` where practical, with
      `--json` as the legacy JSON alias.
- [x] Is `packages/rfapps-cli/src/commands/doctor.ts` required despite most commands currently being
      registered inline in `cli.ts`? Decision: yes; create a dedicated command module for doctor and
      import its registrar from `cli.ts`.

---

_Source: GitHub issue #144; user clarifications; `packages/rfapps-cli` command/action/type pattern
inspection_ _Generated: 2026-06-10T02:02:00Z_ _Status: DRAFT — ready for prp-plan_
