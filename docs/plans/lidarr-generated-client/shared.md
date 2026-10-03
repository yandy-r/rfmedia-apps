# Lidarr Generated Client

Issue #194 replaces the temporary handwritten Lidarr endpoint layer beneath the stable
`LidarrClientApi` facade. A complete, commit-pinned official Lidarr OpenAPI snapshot generates a
private, committed Fetch SDK; generated code owns paths, verbs, query serialization, and wire DTOs.
Handwritten `client.ts` selects four named operations and projects untrusted results, while a new
`transport.ts` remains the sole owner of origin, credential, redirect, timeout, body-limit, and
strict-decoding policy. Ordinary generation and CI are offline; only an explicit immutable-ref
refresh workflow may contact upstream.

## Relevant Files

- /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/src/lib/lidarr/client.ts: Stable facade to migrate to generated operations.
- /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/src/lib/lidarr/types.ts: Private credentials and strict runtime projections.
- /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/src/lib/lidarr/errors.ts: Stable sanitized error taxonomy and HTTP classification.
- /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/src/types/lidarr.ts: Narrow action-facing domain contracts.
- /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/src/lib/lidarr/client.test.ts: Current transport and facade compatibility tests.
- /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs: Existing network-boundary architecture gate.
- /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/package.json: Workspace scripts, Node floor, and generator pin.
- /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/.github/workflows/rfmedia-cli.yml: Node 22 CI and offline drift integration.
- /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/ROADMAP.md: Issue #194 completion state.

## Relevant Patterns

**Stable facade**: Actions depend only on the four-method interface in
[client.ts](/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/src/lib/lidarr/client.ts).

**Off-object credential binding**: Origin-bound API keys remain in a private `WeakMap` in
[types.ts](/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/src/lib/lidarr/types.ts).

**Sanitized typed failures**: Transport and generated envelopes map into the existing hierarchy in
[errors.ts](/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/src/lib/lidarr/errors.ts).

**Tested native-Node tooling**: Generation scripts follow the package-relative paths, fixtures, and
deterministic diagnostics in
[check-direct-plex-imports.mjs](/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs).

**Generated/manual ownership**: The architecture gate in
[check-direct-plex-imports.mjs](/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-194/packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs)
must enforce that only `client.ts` imports the private generated tree and only `transport.ts`
performs authenticated Lidarr Fetch.

## Relevant Docs

**docs/plans/lidarr-generated-client/feature-spec.md**: You _must_ read this when implementing any
issue #194 task or evaluating a fallback.

**docs/plans/lidarr-generated-client/analysis-architecture.md**: You _must_ read this when changing
runtime boundaries, generated ownership, or security invariants.

**docs/plans/lidarr-generated-client/analysis-patterns.md**: You _must_ read this when reusing tests,
errors, credential storage, architecture checks, or NodeNext conventions.

**docs/plans/lidarr-generated-client/analysis-integration.md**: You _must_ read this when changing
dependencies, the lockfile, CI, packaging, or bundled Fetch configuration.

**docs/plans/lidarr-generated-client/analysis-docs.md**: You _must_ read this when writing the
decision/runbook, attribution, README, PR evidence, or ROADMAP update.

**packages/rfmedia-cli/docs/plans/lidarr-integration-foundation.md**: You _must_ read this when
checking compatibility with the temporary client and the Layer-1 command contracts.
