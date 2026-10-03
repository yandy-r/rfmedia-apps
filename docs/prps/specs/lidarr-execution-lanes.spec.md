# Spec: Lidarr Metadata-Dependency Execution Lanes

## Problem Statement

Lidarr operations have materially different failure domains: local database reads can remain reliable while metadata-backed, discovery, or destructive work is unavailable or unsafe. Without explicit scheduling lanes, one overloaded dependency or high-risk batch can consume shared capacity, obscure the real failure, and prevent operators or machine consumers from deciding whether to retry, defer, or correct input.

## Requirements

### Functional

| #   | Requirement                                                                                                                                                                                                                                                               | Priority | Notes                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Define stable `local-only`, `metadata-dependent`, `discovery`, and `destructive` execution lanes, and require every scheduled Lidarr operation to declare exactly one lane.                                                                                               | Must     | Preserve the identifiers already exported by `packages/rfmedia-cli/src/lib/lidarr/tiers.ts`; research recommends bulkhead isolation by failure mode (`research/rfmedia-lidarr-integration/persona-findings/analogist.md:81`). |
| F2  | Give every lane an independent, validated concurrency limit, operation budget, retry limit, and retry-delay policy, with safe built-in defaults and optional `lidarr` configuration overrides.                                                                            | Must     | A saturated or failing lane must not consume another lane's admission capacity.                                                                                                                                               |
| F3  | Schedule single and batch work through one reusable, abort-aware API that preserves input ordering in results, never exceeds lane limits, and reports accepted, succeeded, failed, and skipped work.                                                                      | Must     | The API must be usable by current read actions and future mutation, discovery, and plan/apply commands without parallel schedulers.                                                                                           |
| F4  | Run the shipped health/circuit gate before each gated batch and keep ungated local-only work free of metadata health checks.                                                                                                                                              | Must     | Reuse `ensureTierHealthy`; metadata outages must not block local-only operations (`research/rfmedia-lidarr-integration/report.md:126`).                                                                                       |
| F5  | Classify failures at the scheduler boundary as Lidarr unreachable, metadata provider unavailable, rate-limited, validation, or the stable existing taxonomy code when more specific, while retaining retryability, HTTP status, and retry-after metadata.                 | Must     | Do not replace the existing `LidarrError` hierarchy; expose a scheduler-facing projection of it.                                                                                                                              |
| F6  | Honor overload signals from HTTP `429`, overload `503`, and `Retry-After`: delay only within the configured lane cap, consume retry budget deterministically, and report a terminal classified failure when the requested delay exceeds the cap or retries are exhausted. | Must     | The existing client already carries `retryAfterSeconds`; research treats these signals as mandatory scheduler inputs (`research/rfmedia-lidarr-integration/persona-findings/analogist.md:161`).                               |
| F7  | Integrate the scheduler with all currently shipped Lidarr actions while preserving their command names and data payloads; current actions remain in the `local-only` lane and future operations can adopt other lanes without changing scheduler internals.               | Must     | This issue supplies the integration contract before mutation/discovery issues land.                                                                                                                                           |
| F8  | Surface lane, attempts, failure type, retry-after, and aggregate lane statistics in machine-readable command results and concise human output, without contaminating stdout used for JSON/YAML/CSV.                                                                       | Must     | Preserve the current stdout/stderr output separation in `packages/rfmedia-cli/src/commands/lidarr.ts`.                                                                                                                        |
| F9  | Reject invalid lane configuration before any Lidarr request and never retry validation, configuration, authentication, authorization, not-found, or invalid-response failures.                                                                                            | Must     | Non-retryable errors must fail fast and consume no additional operation budget.                                                                                                                                               |
| F10 | Update user documentation, configuration examples, tests, and `ROADMAP.md`; update bash, zsh, and fish completion templates only if the implemented CLI surface adds or changes flags/subcommands.                                                                        | Must     | Default design adds configuration, not CLI flags, so completion churn is conditional and must be explicitly verified.                                                                                                         |
| F11 | Keep automatic replay and mutation execution out of health checks or unrelated commands; deferred work may be invoked only by an explicit scheduler/plan-apply caller.                                                                                                    | Must     | Preserves the explicit-replay contract shipped by #195.                                                                                                                                                                       |
| F12 | Provide extension points for future lane-specific work without adding the future mutation, discovery, or destructive command suites in this issue.                                                                                                                        | Should   | Issues #202, #198-#200, #203+, #222, and #223 remain separately scoped.                                                                                                                                                       |

### Non-Functional

| #   | Requirement            | Target                                                                                                                        | Rationale                                                                   |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| NF1 | Isolation              | A failing or saturated lane consumes zero concurrency slots from another lane.                                                | Fault isolation is the feature's primary reliability promise.               |
| NF2 | Determinism            | With injected clock, delay, and randomness, admission, retry, and result ordering are fully deterministic in tests.           | Scheduler behavior must be testable without real waits or flaky timing.     |
| NF3 | Backward compatibility | Existing Lidarr commands, flags, primary result payloads, and exit behavior remain compatible; scheduler fields are additive. | Current scripts and machine consumers must continue to work.                |
| NF4 | Type safety            | Exhaustive lane and failure unions; no `any`; exported APIs documented with JSDoc.                                            | Matches package strict-TypeScript rules and prevents silent lane omissions. |
| NF5 | Security               | No API keys, raw response bodies, or secret-bearing URLs appear in scheduler events, errors, logs, or JSON output.            | Scheduling observability must not weaken the hardened transport boundary.   |
| NF6 | Resource bounds        | Queue size, attempts, concurrency, and retry delay are finite and validated; aborted work starts no new operations.           | Prevents retry storms, unbounded memory use, and shutdown delays.           |

## Technical Approach

**Strategy**: Add a typed scheduler at the Lidarr library boundary that uses the existing tier descriptors, health gates, circuit breakers, and error taxonomy as its source of truth. Commands and actions consume structured execution results, while configuration supplies validated per-lane policy overrides over frozen defaults.

**Architecture Decisions**:

- One lane model: retain the existing `LidarrTier` identifiers as scheduler lanes because adding a parallel enum would create drift.
- Independent admission: enforce concurrency and budgets per lane because a global pool would violate bulkhead isolation.
- Single retry ownership: the scheduler owns retries for scheduled work; scheduled actions set the resilient client's retry override to zero while retaining its health gates, circuit state, cache, and stale fallback.
- Additive output: attach scheduler metadata to existing action results and command envelopes rather than replacing their domain payloads.
- Configuration-first controls: use safe defaults plus validated `lidarr` configuration; do not add per-invocation flags in this issue.
- Explicit future adoption: ship all four lane policies now, wire current actions to `local-only`, and leave future command suites to declare their lane when implemented.

**Key Components**:

- `LidarrScheduler`: admits and executes lane-tagged work, applies budgets and retries, and returns ordered structured results. Metadata-dependent tasks compose with the resilient client, which applies the shipped health/circuit gate on each attempt.
- `LidarrLanePolicy`: frozen defaults plus validated configuration overrides for concurrency, operation budget, retry count, and delay cap.
- `LidarrExecutionFailure`: stable scheduler projection of the existing Lidarr error taxonomy and overload metadata.
- Lidarr action/command integration: routes current work through the scheduler and renders additive lane/result metadata for humans and machine formats.

## Integration Points

| System/Service            | Direction                  | Protocol                                          | Notes                                                                                                      |
| ------------------------- | -------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Lidarr local API          | Outbound                   | HTTPS/REST                                        | Current reads use the local-only lane through the generated-client facade and hardened transport.          |
| Lidarr metadata provider  | Indirect outbound          | Lidarr health and metadata-backed REST operations | Metadata-dependent work is gated and isolated; the CLI does not call `api.lidarr.audio` directly.          |
| Discovery providers       | Outbound (future consumer) | HTTPS/REST                                        | The discovery lane policy ships now; provider commands remain out of scope.                                |
| rfmedia configuration     | Inbound                    | YAML/JSON                                         | Validated per-lane overrides extend the existing `lidarr` configuration.                                   |
| rfmedia output formatters | Outbound                   | Text/JSON/YAML/CSV                                | Scheduler metadata is additive; structured stdout remains clean.                                           |
| Lidarr resilience layer   | Both                       | In-process typed APIs + SQLite-backed state       | Reuse health gates, circuit breakers, retry metadata, stale cache, and explicit deferred replay contracts. |

## Risks & Unknowns

| Risk                                                                 | Likelihood | Impact | Mitigation                                                                                                                           |
| -------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Double retry amplification between scheduler and resilient client    | M          | H      | Define one retry owner per failure class and test exact attempt counts and delay sequences.                                          |
| Current single-request commands make lane statistics feel artificial | M          | M      | Keep metadata additive and concise; design the result shape for future batches without changing current domain payloads.             |
| Per-lane configuration becomes too complex                           | M          | M      | Expose only concurrency, budget, retry count, and delay cap; validate ranges and retain frozen defaults.                             |
| A `503` represents a Lidarr outage rather than overload              | M          | H      | Preserve existing taxonomy unless an overload signal is present; never collapse metadata-provider detection or generic 5xx handling. |
| Scheduler integration changes error or exit semantics                | L          | H      | Characterization-test all four current commands in human and machine modes before and after integration.                             |
| Completion templates drift                                           | L          | M      | Assert no completion changes are required unless flags/subcommands change; run the bash/zsh/fish parity suite either way.            |

## Open Questions

- [x] Scope: integrate current actions and reusable future-facing lane APIs; do not add future mutation/discovery commands.
- [x] Controls: safe defaults plus validated configuration overrides; no new CLI flags by default.
- [x] Priority: all four lanes, overload handling, classification, output parity, tests, docs, conditional completions, and ROADMAP are required.
- [x] Defaults/bounds: local-only `8/1000/1/15000`, metadata-dependent `2/50/1/30000`, discovery `4/100/2/30000`, and destructive `1/25/0/15000`; validated global bounds are `1..32`, `1..10000`, `0..10`, and `1..300000` respectively.
- [x] Output shape: action results carry additive `execution`; scheduler-tagged failures are projected into the command error envelope through private `WeakMap` metadata.

---

_Source: GitHub issue #196, accepted defaults, `research/rfmedia-lidarr-integration/`, and predecessor design `docs/plans/lidarr-metadata-resilience/design.md`_
_Generated: 2026-07-22T00:00:00Z_
_Status: IMPLEMENTED — validated 2026-07-22_
