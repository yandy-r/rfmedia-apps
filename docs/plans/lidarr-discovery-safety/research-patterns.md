# Pattern Research: lidarr-discovery-safety

## Architectural Patterns

### Keep the existing boundary stack

The current discovery feature is split into four deliberate layers:

1. `packages/rfmedia-cli/src/types/discovery.ts` owns public, generated-client-independent,
   immutable contracts.
2. `packages/rfmedia-cli/src/lib/discovery/lastfm.ts` owns the fixed-origin Last.fm transport,
   strict wire validation, bounded response handling, and secret-safe provider errors.
3. `packages/rfmedia-cli/src/actions/lidarr/discover.ts` is framework-independent orchestration. It
   validates runtime input, schedules provider work in the `discovery` lane, removes the seed,
   deduplicates and ranks results, and optionally hands one exact-MBID candidate to add planning.
4. `packages/rfmedia-cli/src/commands/lidarr-discover.ts` owns Commander parsing, option grammar,
   presentation, stable machine projections, exit status, and lazy action loading.

Issue #205 should preserve those boundaries. The proposed
`packages/rfmedia-cli/src/lib/discovery/policy.ts` should be a pure, deterministic policy module:
no Commander types, prompts, configuration loading, provider calls, Lidarr calls, file writes, or
global state. It should receive already validated recommendations plus explicit safety settings and
visited identities, then return immutable candidate decisions, effective limits, and stable reason
codes. The action should orchestrate traversal and provider scheduling around that pure policy; the
command should only parse, invoke, render, and request operator input where the final design requires
it.

`packages/rfmedia-cli/src/commands/lidarr.ts` already constructs the discovery leaf through
`createLidarrDiscoverCommand(...)` with injected output and failure helpers. Preserve this
cycle-avoiding command-factory pattern. Action modules are loaded lazily from
`packages/rfmedia-cli/src/actions/lidarr/index.ts`; new public action constants or option types should
be re-exported through that barrel.

### Separate candidate approval from mutation approval

The existing safety contract in `packages/rfmedia-cli/docs/features/lidarr-discovery.md` is stronger
than an in-command POST:

- ordinary discovery performs zero Lidarr calls;
- `discover --add <rank>` writes a sealed `artist-add` plan only;
- `rfmedia lidarr apply <plan>` performs a dry-run review, prompts interactively, and requires
  `--yes` for machine or non-interactive apply;
- `executeLidarrApply` independently rejects a real apply whose `approved` flag is false.

Therefore, #205's quarantine/approval state should mean “eligible and selected for an add plan,” not
“authorized to create the artist.” Candidate approval must not bypass the separately named
plan/apply workflow. Reuse `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts` and the
existing apply lane instead of adding a direct mutation path to discovery.

The closest preview/confirmation implementations are:

- `packages/rfmedia-cli/src/commands/lidarr.ts`: run `executeLidarrApply` with `dryRun: true`, render
  the review, prompt, pin the reviewed plan ID/checksum, then call the real action;
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: reject prompting for
  non-interactive or machine output and render cancellation as a clean no-op;
- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.ts`: re-read fresh state under the apply
  lock, call an injected framework-independent confirmation seam, revalidate before each dispatch,
  and stop later admissions after uncertainty.

If #205 adds an approval prompt before writing plans, inject the confirmation seam rather than
importing prompt code into the action. Preview must return the complete review without plan or
mutation writes, and a declined approval must be a typed, successful no-op.

### Keep retry and identity ownership explicit

`executeLidarrDiscover` schedules an idempotent provider task; the Last.fm transport makes exactly
one request and never implements its own retry loop. Deep traversal should schedule bounded
discovery tasks through the same scheduler rather than calling the provider recursively outside it.

Candidate identity is currently MBID-first, with normalized provider name as the fallback, in
`candidateIdentity()` in `packages/rfmedia-cli/src/actions/lidarr/discover.ts`. Extract or share that
identity rule with the policy layer so visited tracking, seed removal, deduplication, per-seed caps,
and add eligibility cannot disagree. Use a `Set<string>` for traversal membership and deterministic
queue order. `--no-cascade` must prevent discovered candidates from becoming new seeds; `--deep`
must still terminate on the visited set and all configured caps.

The current Last.fm recommendation contract exposes similarity but no popularity metric. Diversity
boosting or popularity dampening must operate only on explicitly typed evidence; it must not infer
popularity from rank or similarity. If evidence is absent, use a documented neutral policy result or
reject a mode that requires unavailable evidence.

## Code Conventions

- Use `readonly` interfaces, literal unions, and discriminated unions as in
  `LidarrDiscoverHandoff`. Return frozen arrays and nested objects with `Object.freeze`; do not leak
  mutable `Set` or `Map` instances in public results.
- Keep optional properties omitted when absent rather than assigning `undefined`. The package is
  strict TypeScript with `noUncheckedIndexedAccess`, and existing code uses conditional object
  spreads for exact optional shapes.
- Define named default and maximum constants beside the public discovery types, then import those
  constants in both command and action layers. Avoid duplicated numeric limits.
- Validate twice at the correct boundaries. Commander `argParser` functions provide immediate CLI
  errors, while the action or pure policy must revalidate all runtime values before loading config,
  resolving the scheduler, calling providers, or writing plans. Current examples are `parseLimit()`
  in `commands/lidarr-discover.ts` and `resolveLimit()` in `actions/lidarr/discover.ts`.
- Use `InvalidArgumentError` for malformed option values and
  `MissingRequiredArgumentError` for invalid option relationships. Extend
  `validateHandoffGrammar()` (or a renamed discovery grammar validator) so add-only resources and
  safety-mode combinations fail before lazy action import.
- Treat Commander negated booleans explicitly when mapping options. Current code maps
  `--no-autocorrect` with `cmdOptions["autocorrect"] !== false`; apply the same care to
  `--no-cascade` so its effective default is visible in the action options and machine result.
- Keep command actions thin: resolve the output format, validate grammar, lazy-load the action,
  construct a plain typed options object, render exactly once, and set `process.exitCode` rather
  than calling `process.exit()`.
- Preserve output contracts. JSON/YAML should remain one envelope; CSV should retain a mandatory
  summary row even for zero candidates and use a fixed ordered column list. Add policy, traversal,
  quarantine, and reason fields additively and render human output on stderr.
- If safety defaults become configuration, extend `DiscoveryConfigOptions` in
  `packages/rfmedia-cli/src/types/config.ts` and the exact allowlists and validators in
  `packages/rfmedia-cli/src/lib/config.ts` together. Unknown keys currently fail closed.

## Error Handling

Local safety-policy input failures should use `LidarrValidationError("lidarr discover", message)` so
they carry the existing `validation`, `operation`, and `retryable: false` contract. Reject invalid
thresholds, unsafe cap relationships, unavailable required scoring evidence, and impossible
traversal modes before provider or Lidarr dependency resolution.

Provider failures must remain `LastFmProviderError` values from
`packages/rfmedia-cli/src/lib/discovery/lastfm.ts`. They expose only stable structural metadata
(`code`, `retryable`, optional status and retry delay), retain no raw URL/body/cause, and leave retry
ownership to the scheduler. Do not wrap them in policy-specific strings that lose this metadata.

The command should continue routing thrown failures through `reportLidarrFailure`, which redacts
sensitive values, emits a stable machine failure envelope, renders execution metadata for humans,
and sets exit code 1. API keys must be passed only as redaction values and must never enter policy
results, plans, visited identities, logs, or errors.

Per-candidate ineligibility is expected data, not necessarily a thrown command failure. Model
quarantine/filtered/already-visited/threshold/cap decisions with a discriminated result and stable
reason codes. A requested plan handoff may remain an in-document failed outcome, following the
current `LidarrDiscoverHandoff` behavior: preserve the complete attributed discovery result, emit
one machine document, then set exit status after rendering.

Fail closed around mutation. Missing exact MBID, ambiguous Lidarr lookup, changed resources,
unapproved real apply, or uncertain dispatch must never be converted into “approved” or retried
blindly. Existing artist-add apply already persists possible-dispatch evidence and reconciles by
exact MBID; reuse that contract.

## Testing Approach

Add only tests that prove a distinct safety boundary.

1. Add a focused `packages/rfmedia-cli/src/lib/discovery/policy.test.ts` for the pure policy. A small
   table should prove threshold inclusion/exclusion, global and per-seed caps, MBID/name
   deduplication, visited-loop rejection, no-cascade versus bounded deep traversal admission, and
   deterministic ordering. Include one diversity/popularity case only if the implemented contract
   has real typed evidence.
2. Extend `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts` with critical orchestration
   cases: invalid policy rejects before config/provider resolution; preview or declined approval
   writes no plan and performs no Lidarr mutation; deep traversal never revisits an identity and
   cannot exceed the effective budgets; approved exact-MBID candidates are handed only to plan
   generation. Preserve attribution and execution metadata.
3. Extend the existing “similar artist discovery” block in
   `packages/rfmedia-cli/src/commands/lidarr.test.ts` with one option-forwarding/default-preview
   contract and one invalid-grammar or non-interactive-approval contract. Assert the action is not
   loaded/called on grammar failure and that machine output remains a single document.
4. Update the single parity contract in
   `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`. It already extracts the exact
   `lidarr discover` option list from Bash, Zsh, and Fish, checks which options require values,
   checks file completion, rejects forbidden flags, and proves completion generation performs no
   provider/Lidarr/config I/O. Add the new options and value classifications there rather than
   creating three redundant tests.

Follow the existing Vitest mock style: declare ESM seams with `vi.hoisted`, install `vi.mock` before
importing the subject, use `createLidarrScheduler` for real scheduler behavior, use
`createLidarrClientMock` only when the plan handoff is exercised, and use temporary directories only
for an actual artifact-write assertion. Do not add new Last.fm transport tests unless the provider
wire contract changes, and do not duplicate plan/apply tests already proving confirmation,
checksum, exact-MBID read-back, and no blind retry.

## Patterns to Follow

- Put policy types and stable decision codes in
  `packages/rfmedia-cli/src/types/discovery.ts`; re-export public contracts through
  `packages/rfmedia-cli/src/types/index.ts`.
- Implement deterministic selection and traversal admission in
  `packages/rfmedia-cli/src/lib/discovery/policy.ts`; keep it pure and independently testable.
- Let `packages/rfmedia-cli/src/actions/lidarr/discover.ts` own input revalidation, scheduler calls,
  traversal queue/visited state, attribution, and the existing exact-MBID plan handoff.
- Let `packages/rfmedia-cli/src/commands/lidarr-discover.ts` own Commander options such as
  `--max-add`, `--max-per-seed`, `--no-cascade`, `--deep`, threshold/diversity controls, option
  relationships, human review, and stable machine projection.
- Keep preview/quarantine as the default discovery outcome. Candidate selection may create sealed
  plans; only `lidarr apply` may create artists, after its existing review and approval gate.
- Update all three static templates together:
  `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`, then lock their exact parity in
  `templates.spec.ts`.
- Preserve fixed Last.fm origin, mandatory attribution, scheduler-owned retries, secret redaction,
  strict exact-MBID mutation identity, and fail-closed behavior at every cap or approval boundary.
