# Engineering Practices Research — Lidarr Quality Presets

## Executive Summary

Issue #213 should be implemented as a dedicated, declarative convergence feature that reuses the
existing Lidarr connection, generated-client facade, scheduler, error taxonomy, output, approval,
and test seams. It should not be added to `rfmedia.lidarr-plan.v2`: that engine is intentionally
optimized for sealed, numeric artist/album targets, while presets manage name-addressed global
resources whose IDs are discovered during an ordered apply.

The simplest maintainable boundary is command presentation → one orchestration action → a pure
preset resolver/diff engine → narrow additions to `LidarrClientApi`. Keep generated DTOs private,
make desired-state comparison deterministic and side-effect free, and let the action own ordered
I/O and post-write verification. Avoid a generic reconciliation framework, a second HTTP client,
plugin-loaded preset providers, rollback machinery, or persistence until a second feature proves
those abstractions necessary.

## Existing Reusable Code

| Existing code                                                                                                                          | Reuse                                                                                                                                        | Concrete tradeoff                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/lidarr/client.ts`: `LidarrClientApi`, `LidarrClient`, `#execute`, `#executeVoid`                         | Add narrow configuration read/write methods here and keep operation labels, generated envelopes, cancellation, and error mapping consistent. | Widening `LidarrClientApi` also requires updating the resilience wrapper and shared mock builder, but is preferable to a second client boundary.                                                               |
| `packages/rfmedia-cli/src/lib/lidarr/transport.ts`: `createLidarrTransport`                                                            | Reuse unchanged for API-key injection, canonical-origin confinement, timeout composition, redirect/header checks, and bounded bodies.        | Calling generated operations directly from the preset engine would bypass this architectural boundary and duplicate security behavior.                                                                         |
| `packages/rfmedia-cli/src/lib/lidarr/types.ts`: focused projectors such as `projectLidarrQualityProfiles`                              | Follow the same unknown-to-frozen-domain projection pattern for full quality profiles, custom formats/schema, and naming.                    | The existing `LidarrProfile { id, name }` projection is deliberately too narrow; changing it would couple artist-assignment callers to definition-management detail. Add distinct domain types and projectors. |
| `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`                                                                             | Reuse the committed custom-format, quality-profile/schema, and naming operations already generated.                                          | Generated PUT path IDs are string-typed; the facade should hide that wire quirk. Generated dynamic `Field.value` remains `unknown`, so generated types alone are insufficient validation.                      |
| `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`                                                                       | Extend the offline contract test with representative required operations, methods, paths, envelopes, and wire types.                         | This is a contract guard, not a substitute for facade projection and body-construction tests. No OpenAPI refresh is justified by issue #213.                                                                   |
| `packages/rfmedia-cli/src/lib/lidarr/index.ts`: `resolveRequiredLidarrClient`, `resolveRequiredLidarrOrigin`, `resolveLidarrScheduler` | Reuse connection/config resolution and the `local-only` scheduler lane. Pass `retryAttemptsOverride: 0` for mutation orchestration.          | The resolver returns the resilience-decorated full facade, so newly added methods must be forwarded by `createLidarrResilienceContext`.                                                                        |
| `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: `LIDARR_IN_PLACE_RETRY_ALLOWLIST`, `createLidarrResilienceContext`                | Add new GET methods to the explicit read allowlist only after classification; forward mutation methods without adding them to the allowlist. | Automatic retries are safe for reads but unsafe for ambiguous POST/PUT results. Apply must re-read and reconcile instead of hot-retrying writes.                                                               |
| `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: `runSingle` and `LidarrExecutionMetadata`                                          | Use one idempotent scheduled task for list/diff and a non-retried apply orchestration task; return existing execution metadata.              | Per-resource scheduler tasks would complicate dependency ordering and permit accidental parallel writes. Custom formats, refreshed IDs, profiles, and naming should remain an explicit sequence.               |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`: `resolveProfilePlanContext` pattern                                 | Reuse the action convention of fresh parallel reads, semantic resolution, and pure result construction.                                      | Reuse the pattern, not its artifact creation or numeric profile-assignment model. Issue #213 edits profile definitions and does not assign artists.                                                            |
| `packages/rfmedia-cli/src/actions/lidarr/apply-resources.ts`: catalog preflight pattern                                                | Reuse its complete-catalog read, map construction, missing-resource detection, and stable warning approach.                                  | Presets identify portable resources by normalized name first, then bind to live IDs; the existing apply preflight binds sealed references by numeric ID.                                                       |
| `packages/rfmedia-cli/src/lib/lidarr/plan-validation.ts`: `requireExactKeys`, `requireString`, `assertNoSensitiveKeys`                 | Reuse the validation ideas: exact keys, bounded terminal-safe text, forbidden prototype keys, and recursive secret-key rejection.            | These helpers throw `LidarrPlanValidationError`, so importing them into config parsing would leak the plan-artifact error contract. A few feature-local `ConfigError` checks are acceptable duplication.       |
| `packages/rfmedia-cli/src/commands/lidarr.ts`: `resolveFormat`, `reportLidarrFailure`, machine/human parity                            | Register the new `presets` command and reuse failure/output conventions.                                                                     | This file is already large; put command construction and preset rendering in `commands/lidarr-presets.ts`, with `lidarr.ts` only supplying shared callbacks and registering it.                                |
| `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`: `createLidarrClientMock`                                       | Extend the typed default mock for facade-wide tests. Feature engine tests should use smaller plain snapshots, not this full mock.            | Every facade addition expands the mock object; a preset-specific `Pick<LidarrClientApi, ...>` capability keeps action helpers focused without introducing another runtime client.                              |
| `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and `templates.spec.ts`                                            | Add static `presets list                                                                                                                     | diff                                                                                                                                                                                                           | apply` parity and value-taking option coverage in all three shells. | The templates intentionally perform no config or network access, so preset names should not be dynamically queried during completion. |

## Modularity Design

Use four layers with one-way dependencies:

1. `types/lidarr-presets.ts` owns generated-independent pack, live projection, diff, and apply
   result contracts. A separate type file is justified because the shapes are substantially richer
   than `types/lidarr.ts`, as demonstrated by the existing `types/lidarr-plan.ts` split.
2. `lib/lidarr/profile-presets.ts` owns built-in packs, normalization, semantic reference
   resolution, validation against live schemas, canonical comparison, and deterministic diff.
   Functions in this module should accept values and return values; they must not resolve config,
   call the client, prompt, log, format, or mutate inputs.
3. `actions/lidarr/profile-presets.ts` owns selection of the built-in/configured pack, fresh reads,
   scheduler use, ordered mutation, read-back verification, partial outcomes, and cancellation.
   Keep `executeLidarrPresetList`, `executeLidarrPresetDiff`, and `executeLidarrPresetApply` as the
   public action entry points, with small private stage helpers rather than one deeply nested apply
   function.
4. `commands/lidarr-presets.ts` owns Commander construction, confirmation, human tables, CSV
   projection, and machine envelopes. `commands/lidarr.ts` should only register the returned
   command and pass its existing format/failure callbacks.

Keep config wiring in `types/config.ts` and `lib/config.ts`. If deep pack parsing makes
`lib/config.ts` materially harder to review, extract only that parser to
`lib/lidarr/profile-preset-config.ts`; do not create a general schema framework in the same change.

The facade additions belong in `lib/lidarr/client.ts`, and unknown-wire projectors belong in
`lib/lidarr/types.ts`. Generated operations and DTOs must not leak into the pure engine, action,
command, config types, or public action result types.

## Shared vs Feature-Specific

Keep these shared:

- canonical connection resolution, credential handling, transport, error taxonomy, scheduler, and
  execution metadata;
- machine output through `formatOutput`, human-output conventions, approval conventions, and
  shell-completion parity;
- the existing facade and resilience decorator;
- bounded projection conventions and architecture/contract checks.

Keep these feature-specific:

- built-in preset data and provenance;
- pack config validation and semantic-name normalization;
- custom-format specification validation against live schemas;
- quality-profile skeleton construction and custom-format score resolution;
- naming managed-field merge and semantic comparison;
- dependency ordering and partial preset-apply outcomes.

Do not put preset policy into `plan-engine.ts`, `plan-operation-definitions.ts`, or
`apply-target-execution.ts`. Their exhaustive operation registries, checksummed artifact shapes,
claims, history, deferred replay, and per-target admission are valuable for artist/album mutations
but are the wrong shared abstraction for global configuration convergence.

## KISS Assessment

The minimum viable design is one selected pack, complete fresh reads, a deterministic three-kind
diff, explicit confirmation, ordered upserts, and read-back verification. Omission must mean
"unmanaged," not delete. This avoids ownership registries, migrations, pruning, rename detection,
rollback, and cross-run state.

Prefer a single frozen built-in registry in `profile-presets.ts` initially. Splitting each curated
pack into a file or loading packs dynamically adds navigation and lifecycle costs without runtime
value. Split data from algorithms only if the curated definitions make the module unwieldy.

Avoid parallel mutation. The expected resource count is small, and Lidarr imposes real dependency
order: custom formats must exist before complete `formatItems` can be built for profiles. Simple
sequential stages are easier to verify and recover than a generic dependency executor.

Do not persist a separate plan artifact in v1. `diff` and `apply --dry-run` provide the review
surface, while real apply recomputes from fresh state before confirmation/mutation. If later
requirements demand offline approval or exact replay, design a dedicated preset artifact family
then, rather than weakening `rfmedia.lidarr-plan.v2`.

## Abstraction vs Repetition

Extract only semantic units that have independent tests:

- `resolvePresetPack` for built-in/config selection and collision handling;
- `validatePresetAgainstSchemas` for all-or-nothing compatibility;
- `diffLidarrPreset` for deterministic managed-field comparison;
- one body builder per resource kind;
- `verifyPresetResource` or resource-specific equality helpers for postconditions.

Do not create a generic `ResourceReconciler<TDesired, TLive, TWire>` in the first implementation.
Custom formats, profiles, and naming have different identities, schemas, creation support, merge
rules, and verification semantics. A shared interface would hide important differences behind
callbacks and make partial-failure behavior harder to audit.

Small repeated stage code is acceptable when it makes mutation order obvious. Share only low-risk
mechanics such as stable name normalization, sorted change keys, immutable copying, summary
counting, and structured failure conversion. Likewise, duplicating a handful of config-safe scalar
checks is preferable to coupling config validation to plan-specific exceptions. If two future
desired-state features need the same reconciliation behavior, extract from proven repetition then.

## Interface Design

Extend the handwritten facade with intention-revealing domain methods, not endpoint-shaped
generated types. Candidate capabilities are:

- `getQualityProfileSchema` and `listQualityProfileDefinitions`;
- `createQualityProfile` and `updateQualityProfile`;
- `getCustomFormatSchema` and `listCustomFormats`;
- `createCustomFormat` and `updateCustomFormat`;
- `getNamingConfig` and `updateNamingConfig`.

Mutation inputs should distinguish create from update so update requires a positive live ID while
create cannot accidentally carry an ID. The facade should hide string-typed generated PUT path IDs,
construct complete wire bodies, and return the freshly projected server response where available.
It should not perform diffing, infer name ownership, prompt, retry mutations, or swallow 404s.

The existing `listQualityProfiles(): Promise<readonly LidarrProfile[]>` must remain unchanged for
artist-profile selection. Adding `listQualityProfileDefinitions` is clearer and safer than
expanding `LidarrProfile`, which would make unrelated callers and fixtures depend on recursive
quality data.

For action-level testability, define a local capability type such as
`Pick<LidarrClientApi, "getQualityProfileSchema" | ...>` rather than a second runtime facade.
`LidarrClientApi` remains the only production client contract, while pure orchestration helpers can
accept the smallest interface they consume.

Result contracts should use discriminated unions and stable keys such as
`custom-format:<normalized-name>`, `quality-profile:<normalized-name>`, and `naming:<id>`.
Keep human rendering outside the action. Machine output should preserve explicit `false`, `0`, and
empty optional collections rather than relying on truthiness.

## Testability Patterns

- Pure engine tests should use table-driven fixtures covering create/update/unchanged,
  case-normalized ambiguity, deterministic ordering, group/quality order, explicit zero scores,
  unmanaged-resource retention, malformed schemas, and no input mutation.
- Facade projector tests in `lib/lidarr/types.test.ts` should reject malformed whole responses,
  duplicate IDs, excessive arrays/recursion, unsafe labels, non-finite scores, and unsupported
  dynamic field values.
- Facade tests in `lib/lidarr/client.test.ts` should assert exact generated operation selection,
  method/path/body translation, cancellation identity, frozen fresh projections, generated PUT ID
  conversion, and sanitized invalid-response failures.
- Resilience tests should prove new reads are intentionally allowlisted and new POST/PUT methods
  are never retried in place.
- Action tests should use `createLidarrClientMock` or a preset-specific `Pick` mock to prove dry-run
  performs zero mutations, validation fails before every write, stages run in dependency order,
  IDs are refreshed after custom-format writes, ambiguous network results trigger read-back, later
  dependent stages stop, and reruns skip satisfied resources.
- Command tests should follow `commands/lidarr.test.ts`: hoisted action mocks, hierarchy/option
  assertions, argument forwarding, confirmation behavior, stdout/stderr parity, structured errors,
  and exact JSON/YAML/CSV envelopes.
- Config tests should cover backward compatibility, unknown nested keys, duplicate normalized
  names, built-in collisions, bounds, forbidden prototype keys, and precise property paths.
- Shell tests in `templates.spec.ts` must lock the same `list`, `diff`, and `apply` hierarchy and
  options across Bash, Zsh, and Fish without loading config or contacting Lidarr.

## Build vs Depend

Build this feature on the committed generated SDK and existing TypeScript/Vitest/Commander stack.
No new runtime dependency is warranted:

- a third-party Lidarr SDK would duplicate transport, authentication, projection, and error
  boundaries;
- a deep-diff package would not understand managed fields, significant array order, server IDs, or
  Lidarr normalization;
- a validation framework would add a second repository-wide config idiom for one nested section;
- a graph/workflow library is unnecessary for a fixed four-stage sequence;
- a templating library is inappropriate because naming formats must be preserved and validated by
  Lidarr, not interpreted by rfmedia.

Continue using `@hey-api/openapi-ts` only as the existing offline code generator. Do not refresh the
OpenAPI snapshot or bump the generator unless a contract test demonstrates that the committed
operations cannot represent the required request or response.

## Open Questions

1. Should built-in packs ship in the first issue, and if so, who owns the exact quality names,
   scores, naming templates, compatibility range, and versioning policy? Architecture can preserve
   these values but cannot establish them safely.
2. Is a configured pack selected only by `--preset`, or can
   `lidarr.profilePresets.default` supply the omitted value? The latter is convenient but must never
   imply automatic apply.
3. Should naming be optional per pack and compared only on supplied fields, or must every pack own
   the complete supported naming projection? A managed-field patch best preserves unrelated live
   settings, while a full definition is easier to reason about.
4. When a same-name custom format or profile exists, is name alone sufficient authorization to
   update it, or should configured packs require an explicit `adoptExisting` flag? Name-only
   convergence is simpler but has a larger accidental blast radius.
5. Does the first release need artist-assignment impact counts and naming examples in the diff?
   Both improve review quality but add reads and projection surface; neither is required to perform
   safe convergence.
6. Should a naming failure run independently after a custom-format failure, or should any earlier
   failure stop all later stages? Strict stop-on-failure is simpler and easier to explain; treating
   naming as independent can make more progress but complicates partial outcomes.
7. Is config-only desired state sufficient, or is an external preset file required? Reusing the
   loaded config is the smaller, safer first surface and avoids another path/security/parser
   boundary.
