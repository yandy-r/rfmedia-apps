# Architecture Research: lidarr-quality-presets

## System Overview

`rfmedia` is a Commander-based TypeScript CLI with a deliberate command → action → handwritten
library/facade → private generated-client dependency direction. For Lidarr, `cli.ts` loads and
validates configuration before dispatch, command modules own argument handling and rendering,
framework-agnostic actions orchestrate work, pure library modules own domain policy, and
`lib/lidarr/client.ts` is the sole handwritten importer of the generated OpenAPI SDK. Issue #213
should add a sibling desired-state workflow under `rfmedia lidarr presets`; it must not extend the
sealed, numeric-target `rfmedia.lidarr-plan.v2` artifact family.

## Relevant Components

- `packages/rfmedia-cli/src/cli.ts`: Root program registration and `preAction` hook. It loads config,
  stores it through `setLoadedConfig`, and resolves the global text/JSON/YAML/CSV mode before a
  Lidarr leaf executes.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Existing `rfmedia lidarr` namespace, shared output
  resolution, redacted failure rendering, and subtree registration point. It should register a
  focused command factory from the planned `commands/lidarr-presets.ts` rather than absorb four
  more full command handlers.
- `packages/rfmedia-cli/src/commands/lidarr-search.ts`,
  `packages/rfmedia-cli/src/commands/lidarr-albums.ts`, and
  `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Existing examples of extracted
  Lidarr subtrees, lazy action imports, fixed CSV projection, human rendering on stderr, and
  machine rendering on stdout.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: Public Lidarr action barrel. The new preset
  entrypoints and result types should be exported here so the command layer keeps the existing
  mockable action boundary.
- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.ts` (planned): Orchestration owner for
  offline discovery, live preflight/diff, impact lookup, origin-scoped locking, ordered mutation,
  drift checks, read-back verification, bounded journaling, and stop-on-first-nonconverged
  outcomes.
- `packages/rfmedia-cli/src/lib/lidarr/profile-presets.ts` (planned): Pure, generated-independent
  policy layer for the frozen built-in registry, qualified reference resolution, validation,
  canonicalization, request intent construction, and deterministic semantic diff. This module is
  the main unit-test seam and must not read config, access the network, render, or persist.
- `packages/rfmedia-cli/src/types/lidarr-presets.ts` (planned): Domain contracts for packs, strict
  configured packs, rich live projections, resource/field diffs, machine envelopes, and apply
  outcomes. These types must not import generated wire types.
- `packages/rfmedia-cli/src/types/config.ts`,
  `packages/rfmedia-cli/src/lib/config.ts`, and
  `packages/rfmedia-cli/src/lib/loaded-config.ts`: Typed configuration, validation, and loaded
  process state. Add the exact-key, bounded `lidarr.profilePresets` subtree here while retaining
  backward compatibility when it is absent.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Stable `LidarrClientApi` facade and sole allowed
  generated-SDK importer. It needs separate rich quality-profile, custom-format, schema, and naming
  methods; the existing narrow `listQualityProfiles(): LidarrProfile[]` must remain intact for
  artist profile assignment.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Strict wire-to-domain projectors. New recursive
  custom-format/schema and quality-profile projectors belong here so actions never consume
  generated response shapes or unbounded `unknown` data.
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`: The committed snapshot already owns
  the required endpoints: custom-format collection/schema/create/update, quality-profile
  collection/schema/create/update, and naming singleton/examples/update. It should remain generated
  and unchanged unless a contract test proves it cannot express the frozen feature.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts`: The only authenticated Fetch owner. New facade
  calls automatically inherit canonical-origin confinement, header-only API-key injection,
  redirect rejection, timeout/cancellation composition, response-body limits, and sanitized typed
  errors.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`: Resolves the canonical origin, resilience-decorated
  client, and process-shared scheduler from loaded config. Preset live workflows should obtain
  these dependencies here rather than reconstruct connection or retry policy.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Explicit safe-read retry allowlist around
  `LidarrClientApi`. Add only the new GET methods to the allowlist; POST/PUT methods must remain
  non-retried so ambiguous dispatch is reconciled by fresh read-back.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Bounded per-lane admission and retry owner.
  Safe discovery reads may be scheduled in bounded parallel batches; configuration writes must be
  non-idempotent tasks admitted sequentially in dependency order.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Useful precedent for owner-only atomic
  files, claim ownership checks, bounded history, and durable terminal evidence. Its current claim
  is keyed by plan UUID and its history validates `rfmedia.lidarr-plan.v2` entries, so it is not an
  architectural fit for a global preset apply keyed by canonical Lidarr origin.
- `packages/rfmedia-cli/src/lib/formatters/index.ts`: Shared machine serializer and recursive CSV
  formula neutralization. Presets should pass one versioned JSON/YAML document or a fixed-row CSV
  projection through this boundary; text/table rendering stays in the command presenter.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Static completion trees and
  parity tests. They do not introspect Commander, so the new `presets list|show|diff|apply` subtree
  and leaf flags must be added to all three templates explicitly.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and
  `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`: Architecture and generated
  endpoint contract gates. Coverage must prove generated imports stay inside `client.ts`, Fetch
  stays inside `transport.ts`, no handwritten `/api/v1/` paths appear in production, and the
  committed preset endpoints retain their methods, paths, and request envelopes.

## Data Flow

1. `cli.ts` parses the root options, loads YAML/JSON config through `lib/config.ts`, injects the
   validated result into `lib/loaded-config.ts`, and then dispatches a `lidarr presets` leaf.
2. `commands/lidarr-presets.ts` validates the pack reference and flags, resolves the global output
   mode, and lazily calls the action barrel. `list` and `show` stay offline; they resolve built-in
   and configured packs without constructing a client, scheduler, lock, or journal. The command
   owns the single interactive apply confirmation after the complete review, but no business
   mutation logic.
3. The action reads `lidarr.profilePresets`, delegates all pack normalization and validation to the
   pure preset library, and resolves one source-qualified immutable desired-state model. Built-in
   digests and configured-pack validation happen before any network access.
4. For `diff`, `apply --dry-run`, and real `apply`, the action resolves the credential-free
   canonical origin plus the resilient `LidarrClientApi`. It fetches fresh custom-format and
   quality-profile definitions/schemas, naming state/examples, and bounded artist impact data. The
   facade calls private generated functions, the generated client delegates to `transport.ts`, and
   strict projectors return frozen domain models to the action.
5. The pure engine capability-checks the pack against live schemas, resolves portable quality and
   custom-format names to current IDs, preserves undeclared format scores, and produces one stable
   create/update/unchanged/retained diff. Neither `diff` nor `apply --dry-run` writes, locks, or
   journals.
6. A real changing apply acquires an exclusive local lock keyed by a digest of the canonical
   origin, reruns the complete fresh preflight under that lock, and obtains approval against that
   final review. A no-op returns without prompting or issuing writes.
7. Mutation admission is sequential: each custom format gets an immediate drift check, one
   POST/PUT, fresh semantic read-back, and durable outcome; the action then refreshes custom formats
   and quality-profile schema, rebuilds complete profile bodies, applies profiles the same way, and
   finally applies the complete naming singleton. Any stale, failed, uncertain, or non-durable
   result stops later admissions.
8. The action returns a bounded, secret-free versioned result. The command renders accessible
   human review/progress to stderr or sends the JSON/YAML envelope / fixed-union CSV rows to
   `formatOutput` on stdout. A rerun repeats live discovery and naturally converges already
   satisfied resources without rollback or duplicate creation.

## Integration Points

The primary source additions are `types/lidarr-presets.ts`,
`lib/lidarr/profile-presets.ts`, `actions/lidarr/profile-presets.ts`, and
`commands/lidarr-presets.ts`. Existing code changes should be narrow: export the types/actions,
register the subtree from `commands/lidarr.ts`, add rich projectors and facade methods, classify the
new GETs for safe retry, and extend config validation. The facade must convert positive numeric
domain IDs to the generated PUT path type internally and must project every generated response
before it crosses the boundary.

The storage integration is intentionally separate from the current Lidarr mutation-plan format.
The new action may reuse the plan engine's security techniques, but it needs its own origin-keyed
lock identity and preset journal schema because two different pack invocations against one origin
must conflict even when they have unrelated IDs. Both lock and journal must live under the existing
rfmedia state root, use owner-only atomic filesystem operations, register global cleanup for lock
release, and persist semantic state/outcomes rather than credentials or raw wire bodies.

Cross-cutting integration includes exact config/example documentation, user help and README
coverage, the ROADMAP issue row, the three shell completion templates, completion parity tests,
client/projector/generated-contract tests, and the architecture gate. Completion generation must
remain side-effect free: importing the command tree cannot resolve config, instantiate a client,
open the state database, acquire a lock, or contact Lidarr.

## Key Dependencies

- `commander` supplies the nested command tree and option parsing; `console-table-printer`,
  `picocolors`, existing logger/format helpers, and `@rfmedia/common` supply accessible human and
  machine output.
- `js-yaml` parses configured packs through the existing config loader and must be upgraded to the
  patched supported release required by the frozen spec; no second parser or schema framework is
  needed.
- `@hey-api/openapi-ts` is a build-time generator only. The committed private SDK supplies endpoint
  serialization, while handwritten domain types and projectors isolate the rest of the codebase
  from broad optional generated models.
- `p-limit` underpins the existing scheduler. Use its scheduler abstraction for bounded safe reads,
  but enforce dependency-ordered single-write admission in the action.
- Node built-ins (`crypto`, `fs/promises`, `path`, `os`, and abort/signal primitives) plus existing
  safe storage and global cleanup patterns are sufficient for digesting, origin locks, atomic
  journal persistence, interruption handling, and owner-only permissions.
- Vitest covers pure engine, config, projector, facade, action, command, formatter, and completion
  contracts; Node's test runner covers architecture/codegen scripts. No new runtime SDK, diff
  library, workflow engine, regex executor, or database is architecturally necessary.
