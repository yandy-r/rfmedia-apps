# Spec: Compose Security Audit Command (`rfapps audit`)

## Problem Statement

Operators of the `rfapps` compose stack need a dedicated way to evaluate container hardening posture
before deploying or during recurring maintenance. Today security-relevant gaps are split across
lint-style production-readiness checks and broader doctor diagnostics, which makes it harder to
answer whether services are running with risky privileges, host access, or missing resource
guardrails.

## Requirements

### Functional

| #   | Requirement                                                                                                          | Priority | Notes                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| F1  | Provide a dedicated `rfapps audit` command for compose security posture checks                                       | Must     | Source request from GitHub issue #145; command is read-only and focused on security findings                |
| F2  | Evaluate resolved compose configuration, including compose file, env file interpolation, profiles, and config output | Must     | User clarified scope is all resolution sources, not raw `compose.yml` only                                  |
| F3  | Check for root users, Linux capability risks, Docker socket mounts, host networking, and missing resource limits     | Must     | User confirmed all listed checks are must-have for v1                                                       |
| F4  | Report findings by severity and affected service                                                                     | Must     | Human output should make the highest-risk services obvious without requiring JSON processing                |
| F5  | Support machine-readable output with stable finding IDs, severity, service, evidence, and remediation guidance       | Must     | Needed for CI and for future doctor integration                                                             |
| F6  | Reuse existing rfapps service targeting and config override conventions                                              | Must     | Follow `-s`, `--services`, `-g`, `--no-sidecars`, `-f`, `-e`, and `-p` patterns already used by doctor/lint |
| F7  | Integrate with the existing `doctor` framework without duplicating security logic                                    | Must     | Doctor already has a `security` category and should consume or summarize audit findings                     |
| F8  | Keep v1 advisory-only with no automatic remediation                                                                  | Must     | The initial version may suggest compose changes but must not edit files or mutate containers                |
| F9  | Provide configurable exit behavior for automation                                                                    | Should   | Mirror the existing `--fail-on` pattern where practical                                                     |

### Non-Functional

| #   | Requirement             | Target                                                             | Rationale                                                            |
| --- | ----------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| NF1 | Read-only safety        | No compose writes, container mutation, or state writes             | Security audit must be safe to run in local terminals and CI         |
| NF2 | Deterministic reporting | Stable rule IDs, ordering, severity mapping, and evidence fields   | Prevents noisy CI diffs and makes findings trackable over time       |
| NF3 | Bounded runtime         | Full-stack audit completes quickly without registry access         | Security posture checks should be usable as a routine preflight step |
| NF4 | Type safety             | Dedicated audit option/result/finding types with no `any`          | Matches `packages/rfapps-cli` TypeScript conventions                 |
| NF5 | Low duplication         | Shared security rule engine usable by `audit`, `doctor`, and tests | Keeps the existing doctor security category consistent with audit    |

## Technical Approach

**Strategy**: Add `rfapps audit` as a dedicated command over a typed, reusable compose security
audit engine. The command should load the resolved rfapps configuration, apply compose/env/profile
overrides, resolve targeted services, evaluate security rules against resolved compose config, then
render human or machine output without mutating the host.

**Architecture Decisions**:

- Reuse doctor-compatible finding concepts: model audit findings with stable IDs, severities,
  service scope, evidence, and remediation so doctor can include security audit results without
  translating ad hoc shapes.
- Evaluate resolved compose config rather than raw YAML: use the same config and compose resolution
  path as existing rfapps diagnostics so extensions, env interpolation, profiles, and CLI overrides
  are represented.
- Keep audit narrower than lint: lint can remain production-readiness focused, while audit owns
  explicit security hardening checks and can reuse existing rule ideas where they overlap.
- Make remediation advisory only: findings should explain the compose key or pattern to review, but
  v1 must not rewrite compose files or apply hardening automatically.
- Preserve CLI conventions: command registration, lazy action imports, global output handling,
  service targeting, and threshold-based exits should follow the existing `doctor` and `lint`
  behavior.

**Key Components**:

- `packages/rfapps-cli/src/commands/audit.ts`: command definition, options, help text, and lazy
  action import.
- `packages/rfapps-cli/src/actions/audit.ts`: command action for config loading, target resolution,
  audit execution, output, and exit threshold handling.
- `packages/rfapps-cli/src/lib/security-audit.ts`: pure rule catalog and evaluation engine for
  resolved compose service definitions.
- `packages/rfapps-cli/src/types/audit.ts`: audit schema version, severity union, rule IDs,
  finding/result types, and command option contracts.
- `packages/rfapps-cli/src/actions/doctor.ts`: integration point that can call the shared audit
  engine for doctor security findings.

## Integration Points

| System/Service                       | Direction | Protocol          | Notes                                                                                                   |
| ------------------------------------ | --------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `rfapps` command registry            | inbound   | Commander command | Register `audit` with existing global options and a dedicated command module                            |
| `lib/config.ts` / service resolution | outbound  | In-process call   | Load layered config, apply compose/env/profile overrides, and resolve service/group targets             |
| Docker Compose config resolution     | outbound  | CLI/helper call   | Use resolved compose configuration so extensions, profiles, and env interpolation are audited           |
| `doctor` diagnostics                 | both      | In-process call   | Doctor should consume shared security audit findings under its existing `security` category             |
| `lint` rule concepts                 | outbound  | In-process reuse  | Reuse compatible rule metadata or helper patterns where checks overlap without merging command purposes |
| `@rfmedia/common` output utilities   | outbound  | In-process call   | Keep JSON/machine output on stdout and human diagnostics on stderr                                      |

## Risks & Unknowns

| Risk                                                                          | Likelihood | Impact | Mitigation                                                                                 |
| ----------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------ |
| Audit duplicates existing lint hardening checks                               | M          | M      | Define audit as security-focused and share rule helpers where overlap exists               |
| Compose config resolution masks the source location of a risky declaration    | M          | M      | Include resolved evidence in v1 and leave source-location mapping as a possible follow-up  |
| Generic CIS-inspired rules create noisy findings for intentional workloads    | M          | M      | Use clear severities, advisory remediation, and allow future suppressions if noise appears |
| Doctor and audit severity models drift apart                                  | M          | H      | Use a shared audit finding model or explicit mapping covered by tests                      |
| Resource limit checks overlap with operational readiness rather than security | L          | M      | Frame resource limits as blast-radius controls and keep remediation advisory               |

## Open Questions

- [x] Is doctor already available and expected to integrate with this feature? Decision: yes, doctor
      exists and should consume the shared audit logic.
- [x] Should audit inspect only raw `compose.yml` or all resolved configuration sources? Decision:
      inspect compose file, env interpolation, profiles, and resolved compose config output.
- [x] Are root user, capabilities, socket mounts, host networking, and resource limits all in scope
      for v1? Decision: yes, all are must-have checks.
- [ ] Should v1 include suppressions for intentional exceptions, or defer suppression support until
      real audit noise is observed?
- [ ] Should the command be named only `rfapps audit`, or should a future subcommand shape such as
      `rfapps audit security` be preserved?

---

_Source: GitHub issue #145; user clarifications; `packages/rfapps-cli` doctor/lint pattern
inspection_ _Generated: 2026-06-10T03:07:00Z_ _Status: DRAFT — ready for prp-plan_
