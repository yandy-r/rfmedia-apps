# Code Review: PR #244

**PR**: `feat(rfapps): add reconciliation command`
**Head**: `9c590a684b58d0ac48ff93ba1b5c4862c17405b3`
**Base**: `github/master`
**Reviewed**: 2026-07-18
**Decision**: Approved

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-151` (branch: `feat/151-reconciliation-command`)
- **Mode**: Existing feature worktree; no additional review worktree created

## Summary

Three independent reviewers examined correctness, security/performance, and repository quality.
The duplicated plain `--env-file` authority finding is recorded once. Four HIGH findings block
merge; two MEDIUM and one LOW finding are included because the requested workflow requires a full
review-and-fix pass.

## Findings

### CRITICAL

None.

### HIGH

- **[F001]** `packages/rfapps-cli/src/actions/reconcile.ts:482` — Plain `--env-file` authority is omitted from project identity resolution, container observation, and readiness.
  - **Status**: Fixed
  - **Category**: Correctness / Security
  - **Suggested fix**: Canonicalize the selected plain env file once and pass it through project identity, service discovery, container observation, running/status queries, readiness, and mutation. Add a production-path integration test whose env file supplies required interpolation and the Compose project name.

- **[F002]** `packages/rfapps-cli/src/lib/drift.ts:269` — Removing a Compose-managed environment variable is silently treated as in sync.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Compare the running environment against the effective desired environment while excluding unchanged image-default variables, emit `removed` for stale Compose overrides, and add a create/remove/apply convergence test.

- **[F003]** `packages/rfapps-cli/src/lib/reconcile.ts:875` — Reviewed Compose/environment authority is reopened by pathname after the last fingerprint check.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Ensure mutation consumes an immutable private snapshot of the exact resolved Compose authority captured under the lifecycle lock, preserving project-directory semantics and cleaning the snapshot safely. Add a race-focused test proving post-review pathname replacement cannot alter the applied model.

- **[F004]** `packages/rfapps-cli/src/actions/reconcile.ts:513` — An explicitly selected empty group widens reconciliation to every Compose service.
  - **Status**: Fixed
  - **Category**: Correctness / Scope safety
  - **Suggested fix**: Expand an empty service result to all services only when no explicit service, services, or group selector was provided; reject explicit selectors that resolve to an empty scope before observation, locking, or mutation. Add report and auto-apply tests.

- **[F008]** `packages/rfapps-cli/src/actions/reconcile.ts:382` — Env-tool mutation reopens its source file after Docker authority validation.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Capture the effective execution environment used for the validated Docker authority under the lock, pass that pinned environment to snapshot mutation without invoking dotenvx/1Password again, and add a race test proving a replaced wrapper env file cannot redirect the final Docker command.

- **[F011]** `packages/rfapps-cli/src/lib/env-tools.ts:206` — Interpreter-based environment capture honors injected Node bootstrap controls.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Capture the wrapper environment with a fixed, securely resolved native `env -0` executable rather than Node or another interpreter; retain output/time bounds and add a regression test proving injected `NODE_OPTIONS` is captured as data without executing startup code.

- **[F012]** `packages/rfapps-cli/src/lib/env-tools.ts:246` — Dynamically linked native environment capture honors injected loader controls.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Use only a fixed root-owned, non-writable, statically linked environment dumper; validate the executable format has no dynamic interpreter before spawn, and add a real `LD_PRELOAD` regression proving injected loader variables remain inert data. Fail closed when no safe static dumper is available.

### MEDIUM

- **[F005]** `packages/rfapps-cli/src/lib/reconcile.ts:904` — A signal arriving during readiness or final observation can yield exit 0 for a single-service run.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Re-sample interruption state after each awaited post-action phase and before convergence classification; return `cancelled_during_action` with available final drift. Add a single-service controlled test.

- **[F006]** `packages/rfapps-cli/src/mcp/schema.ts:177` — Reconciliation scope is unbounded while each action revalidates the full scope.
  - **Status**: Fixed
  - **Category**: Security / Performance
  - **Suggested fix**: Define one shared maximum scope and service-name length, enforce it after CLI/group resolution and in deterministic plan validation, mirror it in the MCP schema, and test oversized CLI/MCP scopes fail before observation or lock acquisition.

- **[F009]** `packages/rfapps-cli/src/lib/drift.ts:726` — Per-image inspection fans out on every full-scope per-service revalidation.
  - **Status**: Fixed
  - **Category**: Security / Performance
  - **Suggested fix**: Batch or concurrency-bound image-default environment inspection so each full-scope capture launches a bounded number of Docker subprocesses, and add a maximum-scope test proving subprocess count remains bounded rather than quadratic.

- **[F010]** `packages/rfapps-cli/src/actions/reconcile.ts:179` — Unsnapshotable file/environment-backed Compose resources are rejected only after approval and action dispatch.
  - **Status**: Fixed
  - **Category**: Correctness / Operator safety
  - **Suggested fix**: Detect unsnapshotable resources during capture/planning and classify affected services as blocked with a stable reason before confirmation or mutation, or securely snapshot the resources. Add an end-to-end action test proving no prompt/mutation and a blocked result.

### LOW

- **[F007]** `packages/rfapps-cli/src/actions/completion.ts:700` — Zsh completion advertises obsolete always-force-recreate legacy behavior.
  - **Status**: Fixed
  - **Category**: Documentation / Compatibility
  - **Suggested fix**: Replace the stale description with the safe reconciliation wording, update its completion assertion, and verify Bash/Fish descriptions remain consistent.

## Validation Evidence Before Fixes

| Check                                                | Result                                   |
| ---------------------------------------------------- | ---------------------------------------- |
| Focused reconciliation matrix with Docker smoke      | Pass: 363/363                            |
| Full rfapps test suite                               | Pass: 1,260 tests; 2 opt-in skips        |
| rfapps typecheck and build                           | Pass                                     |
| Coverage                                             | Pass: 82.86% statements, 71.38% branches |
| Format, changed Markdown, links, secrets, whitespace | Pass                                     |
| GitHub Actions                                       | Pass: all four checks                    |

## Files Reviewed

All changed production files under `packages/rfapps-cli/src/`, their targeted tests and integration
fixtures, public CLI/MCP schemas and adapters, completions, operator documentation, and the PR diff
against `github/master`.

## Verification Review

- **Correctness**: No findings; F001-F010 verified before the final environment-capture hardening.
- **Quality and compatibility**: No findings; F008-F010 verified with action-path coverage.
- **Security and performance**: No findings after F011-F012 replaced interpreter/dynamic-loader
  capture with a validated static ELF boundary.
- **Final status**: 12 findings Fixed, 0 Open, 0 Failed.
