# Documentation Analysis: managed-update-lifecycle

## Executive Summary

Issue #148 needs one canonical operator guide plus coordinated updates to the rfapps command,
plan/apply, history, rollback, health, output, completion, and roadmap documentation. The central
documentation distinction is that `plan --check-updates` remains read-only/advisory, while
`rfapps update` owns the reviewed detect -> apply -> verify -> exact-image restore lifecycle.
Documentation must never imply that image restoration rolls back Compose configuration, volumes,
databases, or migrations. The required graph query was attempted first, but this worktree has no
`graphify-out/graph.json`; the inventory below is based on the feature spec and completed research.

## Must-Read Documents

| Priority     | Path                                                              | Why it is required                                                                                                                   |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Required     | `docs/plans/managed-update-lifecycle/feature-spec.md`             | Source of truth for CLI, lifecycle, schemas, security gates, phases, and accepted defaults.                                          |
| Required     | `docs/plans/managed-update-lifecycle/analysis-architecture.md`    | Command/action/library boundaries, exact-image restore design, migrations, and critical files.                                       |
| Required     | `docs/plans/managed-update-lifecycle/analysis-integration.md`     | Docker/Compose authority, context binding, target verification, completions, README, and MCP compatibility.                          |
| Required     | `docs/plans/managed-update-lifecycle/research-recommendations.md` | Consolidated implementation order, release gates, restore scope, and resolved trade-offs.                                            |
| Required     | `docs/plans/managed-update-lifecycle/research-external.md`        | Digest identity, multi-platform handling, Compose capabilities, inspection, health, and registry failure semantics.                  |
| Required     | `docs/plans/managed-update-lifecycle/research-security.md`        | Secret-free persistence, TOCTOU checks, hostile saved plans, Docker authority, and redaction requirements.                           |
| Required     | `docs/plans/managed-update-lifecycle/research-ux.md`              | Preview/apply workflows, confirmation, streams, stable outcomes, interruption, and automation behavior.                              |
| Required     | `packages/rfapps-cli/README.md`                                   | Public command reference; currently documents advisory update checks, generic apply, generations, rollback, output, and completions. |
| Required     | `docs/features/plan-apply-workflow.md`                            | Existing `--check-updates` contract that must be clearly separated from managed update plans.                                        |
| Required     | `docs/features/deployment-history.md`                             | Existing action filters, generation rules, JSON fields, and restore-target language.                                                 |
| Required     | `docs/features/deployment-rollback.md`                            | Existing image-only restore contract and manual rollback behavior that must remain compatible.                                       |
| Required     | `docs/features/service-healthchecks.md`                           | Canonical healthcheck policy; informs `healthcheck` versus labeled `running-only` assurance.                                         |
| Required     | `docs/features/secrets-management.md`                             | Existing env-tool boundary and non-disclosure rules for plans, reports, logs, and overrides.                                         |
| Nice-to-have | `docs/features/rfapps-doctor-command.md`                          | Clarifies that doctor freshness checks are diagnostic and never save/apply plans.                                                    |
| Nice-to-have | `docs/features/rfapps-mcp-server.md`                              | Confirms v1 has no remote managed-update mutation tool and generic apply rejects managed intent.                                     |

## Architecture Docs

| Priority     | Path                                            | Documentation/comment impact                                                                                                                   |
| ------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Required     | `packages/rfapps-cli/CLAUDE.md`                 | Update command map, plan/update contracts, action unions, generation identity, and lifecycle architecture examples.                            |
| Required     | `packages/rfapps-cli/src/actions/rollback.ts`   | Revise module/function JSDoc from mutable image-tag pull semantics to exact-ID restore when available; retain legacy manual fallback language. |
| Required     | `packages/rfapps-cli/src/lib/generations.ts`    | Revise module JSDoc/examples: `update` creates verified generations and snapshots carry `imageId`/`imageDigest`, not only `imageTag`.          |
| Required     | `packages/rfapps-cli/src/lib/plan-storage.ts`   | Revise JSDoc to describe managed-plan runtime validation, private atomic files, intent routing, and identity drift rejection.                  |
| Required     | `packages/rfapps-cli/src/lib/health.ts`         | Revise dependency-only JSDoc to distinguish target identity/state/health verification from dependency readiness.                               |
| Required     | `packages/rfapps-cli/src/lib/plan-generator.ts` | Document explicit update status and unknown handling; same-tag digest changes are actionable only in managed intent.                           |
| Required     | `docs/architecture/overview.md`                 | Add the update coordinator and its reuse of plan, Docker, health, history, and generation modules.                                             |
| Required     | `docs/architecture/data-flow.md`                | Add preview/revalidation/apply/verify/restore/report flow and secret-free persistence boundaries.                                              |
| Nice-to-have | `packages/rfapps-cli/AGENTS.md`                 | Keep the package-level agent mirror synchronized only according to the repository's canonical-doc policy.                                      |
| Nice-to-have | `docs/reference/architecture-diagram.md`        | Add managed update only if command-level flows are represented in this broad diagram.                                                          |

## Reading List

### Repository references

- Required: `ROADMAP.md` issue #148 entry and lifecycle exit criteria.
- Required: `README.md` and `docs/README.md` rfapps command lists and feature indexes.
- Required: `docs/features/quick-reference.md`, `docs/features/shell-completion.md`,
  `docs/features/json-output.md`, and `docs/features/error-handling.md`.
- Nice-to-have: `docs/features/dry-run-mode.md` for terminology consistency; bare `update` is preview,
  not merely a generic Docker dry run.

### External references

- Required: issue #148, `https://github.com/yandy-r/rfmedia-apps/issues/148`.
- Required: Compose `config`, `pull`, `up`, and `ps` references under
  `https://docs.docker.com/reference/cli/docker/compose/`.
- Required: container/image inspection and Dockerfile `HEALTHCHECK` references under
  `https://docs.docker.com/reference/cli/docker/` and `https://docs.docker.com/reference/dockerfile/#healthcheck`.
- Required: CNCF Distribution API, `https://distribution.github.io/distribution/spec/api/`, and OCI
  image index, `https://specs.opencontainers.org/image-spec/image-index/`.
- Required: Docker image digest guidance, `https://docs.docker.com/dhi/core-concepts/digests/`, and
  Engine security, `https://docs.docker.com/engine/security/`.
- Nice-to-have: Terraform/OpenTofu saved-plan documentation as UX precedent only; it is not an rfapps
  compatibility contract.

## Documentation Gaps

1. Required: create `docs/features/managed-update-lifecycle.md` as the canonical operator guide. Cover
   preview-only default, flags, saved-plan workflow, per-service statuses/stages, examples, confirmation,
   sequential execution, interruption, report location, exit codes, and troubleshooting.
2. Required: update `packages/rfapps-cli/README.md` with the full command reference and examples;
   explicitly distinguish advisory `plan --check-updates` from actionable managed update intent.
3. Required: update `docs/features/plan-apply-workflow.md` to state that generic `apply` rejects managed
   plans and that `--force` cannot bypass Compose/context/current/proposed identity drift.
4. Required: update `docs/features/deployment-history.md` and `docs/features/deployment-rollback.md` for
   `update` actions, immutable image fields, verified update/restore generations, and legacy tag-only
   manual rollback. State repeatedly that restore is image-only under current Compose configuration.
5. Required: update `docs/features/service-healthchecks.md` to define target verification: expected
   image, running state, Docker health when configured, dependency evidence, and bounded `running-only`.
6. Required: update `docs/features/json-output.md` and `docs/features/error-handling.md` for
   `update.v1`, stable outcomes/stages/error codes, one stdout document, stderr progress, and exit 1 for
   unknown/partial/restored/failed runs; no-update is exit 0.
7. Required: update `docs/features/secrets-management.md` with allowlisted plan/report DTOs, `0700`
   directories, atomic `0600` files, sanitized errors, and prohibition on persisted resolved env values.
8. Required: update `docs/features/shell-completion.md` and `docs/features/quick-reference.md` with
   update options and the preview -> review -> apply -> verify/restore workflow.
9. Required: update `README.md` and `docs/README.md` command/index entries, then update `ROADMAP.md`
   completion status and closing PR when shipped.
10. Nice-to-have: add an operations/troubleshooting section for registry auth/rate limits, stale plans,
    unsupported builds, missing recovery anchors, running-only assurance, restore failure, and manual
    recovery identifiers.
