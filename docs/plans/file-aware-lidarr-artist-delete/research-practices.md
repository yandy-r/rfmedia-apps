# Engineering Practices: File-Aware Lidarr Artist Delete

## Executive Summary

Implement file-aware artist deletion as a new, additive v2 operation that composes the existing Lidarr client facade, plan operation definitions, plan engine, action layer, command layer, and optional post-delete Plex scan helpers. Keep remote deletion under Lidarr's ownership: do not add a dependency, delete files directly from the local filesystem, or introduce a bulk endpoint. Album deletion is outside this work because issue #223 owns that behavior.

The safest implementation shape is a thin vertical slice with explicit inputs and results. Reuse established validation, planning, execution, output, and error-handling conventions; assign implementation tasks in cohesive groups of one to three files; and add only tests that protect the new decision boundary and the existing operation contract.

## Existing Reusable Code

- **Lidarr client facade**: Extend the existing facade with the smallest artist-delete capability needed by the action layer. Keep transport details, generated-client types, authentication, and API error normalization behind the facade.
- **Plan operation definitions**: Add a new artist-delete v2 operation while preserving the meaning and payloads of existing Lidarr operations. Reuse the established operation schema, serialization, validation, and display metadata patterns.
- **Plan engine**: Route the new operation through the current planning and apply lifecycle. Reuse existing ordering, confirmation, dry-run, result aggregation, and failure behavior rather than adding a parallel executor.
- **`actions/lidarr`**: Put the artist-specific orchestration here: resolve the target, select the v2 delete intent, call the client facade, and optionally trigger the post-delete Plex scan. Keep commands free of API workflow details.
- **`commands/lidarr`**: Reuse existing argument parsing, configuration loading, action invocation, output formatting, and exit-code conventions. The command should translate user intent into an action request, not implement deletion logic.
- **Action helpers for optional scans**: Reuse the existing optional post-delete Plex scan pattern. Keep it conditional on the requested behavior and do not introduce a local file scan.
- **Shell completion generators**: Mirror the new option or command surface across all three existing completion generators. Treat parity as part of the CLI contract.
- **Existing tests**: Follow nearby facade, plan-definition, plan-engine, action, command, and completion test patterns. Prefer extending focused suites over creating a new testing framework or broad fixture layer.

## Modularity Design

Use the existing dependency direction:

`commands/lidarr` → `actions/lidarr` → Lidarr client facade

The plan path should remain:

v2 operation definition → plan engine dispatch → Lidarr action → client facade

Recommended responsibilities:

- The command layer owns CLI inputs and presentation.
- The action layer owns artist-delete policy and optional file-awareness.
- The plan operation owns a stable, serializable description of the requested action.
- The plan engine owns lifecycle and dispatch, not Lidarr-specific policy.
- The client facade owns remote API interaction and translation of API failures.

Keep the v2 payload explicit enough that applying a saved plan does not need to reconstruct user intent from mutable command defaults. Preserve existing Lidarr operations unchanged for compatibility. If those operations and the new artist-delete v2 operation share mechanics, extract or reuse a narrowly scoped helper rather than combining their public contracts.

Implementation tasks should each own one cohesive concern and normally touch one to three files. Practical slices are:

1. Facade method and its focused tests.
2. V2 operation definition plus plan-engine dispatch and critical plan tests.
3. Lidarr action/command wiring plus focused behavior tests.
4. Three completion generators and their parity assertions.

This grouping limits merge conflicts, keeps review context small, and gives every task a directly runnable validation target.

## KISS

- Add one v2 operation; do not generalize a universal media-deletion framework.
- Use Lidarr's supported artist-delete behavior; do not add local filesystem deletion.
- Do not invent a bulk endpoint. Process only the artist scope required by this feature through the existing facade contract.
- Do not include album deletion or album-level policy; issue #223 owns albums.
- Avoid new dependencies. Existing client, schema, plan, and test utilities are sufficient.
- Make the optional post-delete Plex scan conditional and visible in the action flow.
- Prefer explicit branches for the small number of delete modes over configuration-driven indirection.

## Testability

Keep policy decisions in pure or easily isolated action-layer logic and keep network calls behind the facade. Tests should assert observable contracts, not internal call choreography unless the choreography prevents a destructive mistake.

Critical coverage:

- The new artist-delete v2 operation validates and round-trips through plan serialization without altering existing Lidarr operations.
- Plan-engine dispatch sends the v2 payload to the correct Lidarr action.
- File-aware deletion triggers the optional post-delete Plex scan only when requested and never performs a local file scan.
- The selected artist-delete request sends the correct remote deletion intent through the facade.
- Missing artists, post-delete Plex scan failures, and Lidarr delete failures preserve existing error and exit-code conventions.
- Dry-run or plan-only paths do not perform deletion.
- All three shell completion outputs expose the same new CLI surface.

Avoid exhaustive permutation tests, snapshots of incidental formatting, and duplicate command/action/facade assertions. One focused test at the layer that owns each contract, plus a small integration-style command or plan-engine test for wiring, is enough.

## Build vs Depend

Build this feature from existing repository primitives. No external package is justified: the work is API orchestration, plan schema extension, and CLI wiring already covered by the current stack.

Do not build:

- a local file-removal utility;
- a generalized bulk deletion client;
- an album deletion abstraction;
- a second plan executor;
- a new scan/cache subsystem;
- a new completion framework.

Depend on the existing Lidarr client facade, plan schemas and engine, action helpers, command framework, completion generators, and test utilities. This minimizes new surface area while retaining compatibility and clear ownership.
