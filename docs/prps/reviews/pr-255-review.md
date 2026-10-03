# PR Review #255 — feat(rfmedia): generate Lidarr API client

**Reviewed**: 2026-07-21T20:18:42Z
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/194-lidarr-generated-client → master
**Decision**: COMMENT

## Summary

The generated client, transport boundary, domain projections, provenance controls, and validation
coverage are cohesive and reproducible. Two handwritten-code issues should be fixed before the PR
leaves draft: rollback must retain its backup if restoration fails, and one obsolete exported type
should be removed.

## Findings

### CRITICAL

None.

### HIGH

- **[F001]** `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.mjs:301` — The unconditional
  `finally` removal deletes the last-known-good backup even if an installed-path removal or backup
  restoration throws during rollback, turning a refresh failure into avoidable local data loss and
  contradicting the documented recovery guarantee.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Remove the backup directory only after a successful install or a fully
    successful rollback; if rollback fails, preserve the confined backup path, surface it in the
    thrown error, and add a deterministic regression test for the rollback-failure path.

### MEDIUM

None.

### LOW

- **[F002]** `packages/rfmedia-cli/src/lib/lidarr/types.ts:30` — `LidarrQueryValue` was part of the
  removed handwritten request builder and has no remaining import or use.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Remove the obsolete exported alias and its stale structured-query comment.

## Validation Results

| Check      | Result                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------- |
| Type check | Pass — rfmedia package typecheck                                                                   |
| Lint       | Pass — format, architecture, whitespace, and changed-file Markdown; unrelated baseline noted in PR |
| Tests      | Pass — 2,210 rfmedia tests, 1,317 rfapps tests, 27 codegen tests, and 24 architecture tests        |
| Build      | Pass — `npm run build:rfmedia` and package dry-run inspection                                      |

## Files Reviewed

- `.github/workflows/rfmedia-cli.yml` (Modified)
- `.prettierignore` (Modified)
- `ROADMAP.md` (Modified)
- `docs/plans/lidarr-generated-client/analysis-architecture.md` (Added)
- `docs/plans/lidarr-generated-client/analysis-docs.md` (Added)
- `docs/plans/lidarr-generated-client/analysis-integration.md` (Added)
- `docs/plans/lidarr-generated-client/analysis-patterns.md` (Added)
- `docs/plans/lidarr-generated-client/analysis-tasks.md` (Added)
- `docs/plans/lidarr-generated-client/feature-spec.md` (Added)
- `docs/plans/lidarr-generated-client/generator-spike.md` (Added)
- `docs/plans/lidarr-generated-client/parallel-plan.md` (Added)
- `docs/plans/lidarr-generated-client/research-business.md` (Added)
- `docs/plans/lidarr-generated-client/research-external.md` (Added)
- `docs/plans/lidarr-generated-client/research-practices.md` (Added)
- `docs/plans/lidarr-generated-client/research-recommendations.md` (Added)
- `docs/plans/lidarr-generated-client/research-security.md` (Added)
- `docs/plans/lidarr-generated-client/research-technical.md` (Added)
- `docs/plans/lidarr-generated-client/research-ux.md` (Added)
- `docs/plans/lidarr-generated-client/shared.md` (Added)
- `package-lock.json` (Modified)
- `packages/rfmedia-cli/CHANGELOG.md` (Modified)
- `packages/rfmedia-cli/README.md` (Modified)
- `packages/rfmedia-cli/THIRD_PARTY_NOTICES.md` (Added)
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` (Added)
- `packages/rfmedia-cli/openapi-ts.config.mjs` (Added)
- `packages/rfmedia-cli/openapi/lidarr-v1.json` (Added)
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json` (Added)
- `packages/rfmedia-cli/package.json` (Modified)
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` (Modified)
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs` (Modified)
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` (Added)
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs` (Added)
- `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.mjs` (Added)
- `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.test.mjs` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/client.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/client.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/client/client.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/client/index.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/client/types.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/client/utils.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/core/auth.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/core/bodySerializer.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/core/params.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/core/pathSerializer.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/core/queryKeySerializer.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/core/serverSentEvents.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/core/types.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/core/utils.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/index.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/transport.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` (Modified)
- `packages/rfmedia-cli/src/types/lidarr.ts` (Modified)
