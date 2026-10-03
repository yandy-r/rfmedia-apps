# Pattern Research: lidarr-quality-presets

## Architectural Patterns

**Layered command/action/domain/facade boundary**: Lidarr features keep Commander and presentation
at the command layer, orchestration and I/O at the action layer, pure policy in `lib/lidarr`, and
generated-independent contracts in `types`. The frozen feature contract should use the same
one-way dependency shape:
`commands/lidarr-presets.ts -> actions/lidarr/profile-presets.ts ->
lib/lidarr/profile-presets.ts -> types/lidarr-presets.ts`.

- Example: `packages/rfmedia-cli/src/commands/lidarr-search.ts`
- Example: `packages/rfmedia-cli/src/actions/lidarr/search.ts`
- Example: `packages/rfmedia-cli/src/lib/lidarr/search.ts`
- Example: `packages/rfmedia-cli/src/types/lidarr.ts`
- Contract: `docs/plans/lidarr-quality-presets/feature-spec.md`

**Sibling command factory with dependency injection**: when a Lidarr subtree becomes substantial,
it moves to a sibling module that imports nothing from `commands/lidarr.ts`. The parent injects
private format, failure, confirmation, parsing, and execution-summary helpers, then registers the
returned `Command`. This avoids an ESM cycle and keeps the parent as the documented namespace
composition root.

- Example: `packages/rfmedia-cli/src/commands/lidarr-search.ts`
- Example: `packages/rfmedia-cli/src/commands/lidarr-albums.ts`
- Registration: `packages/rfmedia-cli/src/commands/lidarr.ts`

**Private generated-client facade**: generated endpoint functions and wire types are imported only
by `lib/lidarr/client.ts`. The handwritten `LidarrClientApi` exposes intention-revealing,
generated-independent methods, validates inputs before transport, unwraps generated envelopes as
`unknown`, projects fresh bounded domain values, and translates every failure into the Lidarr
taxonomy. Authenticated Fetch remains solely owned by `lib/lidarr/transport.ts`.

- Facade and interface: `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- Unknown-to-domain projection: `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- Transport owner: `packages/rfmedia-cli/src/lib/lidarr/transport.ts`
- Enforced boundary: `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- Generated endpoint contract: `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

**Strict immutable domain projection**: wire guards accept `unknown`, bound collections and labels,
reject a malformed whole response, verify unique identities, construct new objects, freeze nested
arrays, and preserve optional fields with conditional spreads. Pure functions return stable sorted
or order-preserving projections rather than leaking generated objects or mutating input.

- Example: `projectLidarrQualityProfiles` and the search projectors in
  `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- Example: cached-result exact-key validation in
  `packages/rfmedia-cli/src/actions/lidarr/search.ts`
- Example: deterministic plan construction in
  `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`

**Scheduled, capability-scoped I/O**: actions validate local inputs before resolving clients,
declare a fixed task ID/operation/tier, and run external work through `resolveLidarrScheduler()`.
Fresh mutation preflight resolves a client with `retryAttemptsOverride: 0`; safe read operations
can use the resilience wrapper and scheduler preflight. The preset workflow is global
configuration, so live diff/apply should use the local-only lane, fresh reads, and no hot retry for
POST/PUT operations.

- Scheduler action: `packages/rfmedia-cli/src/actions/lidarr/search.ts`
- Fresh mutation-plan read: `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`
- Client/scheduler composition: `packages/rfmedia-cli/src/lib/lidarr/index.ts`
- Retry classification: `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`

**Review-first, sequential apply with admission stopping**: the existing apply path separates full
preflight from writes, classifies live state, executes reviewed targets sequentially, performs
per-target verification, and stops admitting later work after stale, uncertain, or non-durable
outcomes. Dry-run returns before claim acquisition and history writes. The preset action should
follow these semantics while remaining independent of the sealed artist/album plan model.

- Orchestration: `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
- Sequential stop-admission loop:
  `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`
- Per-resource classification and verification:
  `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`

**Owner-only atomic persistence and exclusive claims**: Lidarr plan storage validates every path
component, rejects symlinks, verifies ownership/permissions and file identity, writes private
temporary files, fsyncs, and atomically publishes or replaces. Claims use ownership tokens and
remove only a lock still owned by the caller. Presets need a distinct origin-keyed lock and journal,
but should extract or mirror these hardened primitives rather than reuse the existing per-plan-ID
claim as if it were an origin lock.

- Atomic artifact/history I/O and claim implementation:
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- Claim and persistence integration: `packages/rfmedia-cli/src/actions/lidarr/apply.ts`

## Code Conventions

- Use strict TypeScript with ESM `.js` import specifiers. Prefer `readonly` interfaces and
  discriminated unions for public contracts, `as const satisfies ...` for exhaustive registries,
  `Object.freeze` for returned state, and conditional spreads so absent optional fields stay
  absent.
- Name command entrypoints `createLidarr*Command`, action entrypoints `executeLidarr*`, pure
  builders/resolvers `build*`, `resolve*`, `normalize*`, or `project*`, and facade methods by intent
  (`list...`, `get...`, `create...`, `update...`), not by generated operation name.
- Keep hard bounds and stable schemas as module-level uppercase constants. Existing examples
  include collection/string bounds in `packages/rfmedia-cli/src/lib/lidarr/types.ts` and fixed CSV
  columns in `packages/rfmedia-cli/src/commands/lidarr-search.ts`.
- Validate local CLI values before lazy action imports. Use Commander `InvalidArgumentError` for
  parser failures and domain/config errors for semantic failures. Actions must not import
  Commander, tables, color libraries, or output serializers.
- Lazily import actions and `formatOutput` inside command handlers. This keeps completion
  generation static and prevents configuration, client, database, scheduler, or network
  initialization while a shell is completing.
- Human output goes only to stderr via `console.error`, `console-table-printer`, and `picocolors`.
  Machine output emits one stable JSON/YAML envelope on stdout. CSV uses an explicit ordered column
  union and `rowType` discriminator for heterogeneous rows.
  `packages/rfmedia-cli/src/lib/formatters/index.ts` already neutralizes spreadsheet-formula
  prefixes without changing JSON/YAML or mutating the input.
- Keep default human previews bounded, report omitted counts, and preserve identifiers and paths.
  Existing preview/table patterns live in `packages/rfmedia-cli/src/commands/lidarr-albums.ts` and
  `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`.
- Add the new action exports to `packages/rfmedia-cli/src/actions/lidarr/index.ts`; keep generated
  code private and do not export generated types through a public barrel.
- Configuration follows typed optional sections in
  `packages/rfmedia-cli/src/types/config.ts` and field-path-aware validation in
  `packages/rfmedia-cli/src/lib/config.ts`. Unlike older Lidarr subsections that silently drop
  unknown keys, the frozen preset contract requires an exact-key validator at every
  `lidarr.profilePresets` level. Continue using YAML `CORE_SCHEMA`, the existing 1 MiB file bound,
  and secret redaction.

## Error Handling

Similar Lidarr code propagates typed errors upward and renders only at the command boundary.
`packages/rfmedia-cli/src/lib/lidarr/errors.ts` defines stable codes plus operation, status,
retryability, and optional retry delay; `client.ts` preserves existing `LidarrError` values,
converts malformed JSON/projections to `invalid-response`, and maps unknown transport failures to a
sanitized reachability error.

Preset-specific failures should likewise be typed and secret-free, with stable phase/resource
metadata, dispatch state, verification state, retryability, and a concrete next action. Never
persist or render raw response bodies, request headers, API keys, arbitrary causes, or unsanitized
server labels. Validate controls and bounds before a value reaches an error or output model.

The command boundary should follow `reportLidarrFailure` in
`packages/rfmedia-cli/src/commands/lidarr.ts`: structurally read safe metadata, redact explicit
sensitive overrides, emit a machine failure document or concise human diagnostics, and set
`process.exitCode` rather than calling `process.exit()`. Expected no-change is success. Partial,
failed, or uncertain real applies are represented in the result first and then set a failing exit
code. Cancellation should propagate the original abort reason and still release owned locks in a
`finally` block.

For mutation failures, preserve the existing distinction among pre-dispatch failure,
possibly-dispatched uncertainty, verified success, and durable-history failure. The precedents are
`persistOutcome` in `packages/rfmedia-cli/src/actions/lidarr/apply.ts` and reconciliation in
`packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`.

## Testing Approach

Use contract-critical Vitest coverage at each boundary:

1. **Pure preset engine tests** in
   `packages/rfmedia-cli/src/lib/lidarr/profile-presets.test.ts`: validate all three built-ins
   against representative committed fixtures; cover qualified/unqualified resolution,
   duplicate/adoption ambiguity, exact-key and bound failures, stable digest/order, create/update/
   unchanged/retain classification, preservation of unmanaged scores, naming/token/regex
   rejection, and second-run semantic convergence. Prefer table-driven cases and direct immutable
   value assertions.
2. **Projector/facade tests** in `packages/rfmedia-cli/src/lib/lidarr/types.test.ts` and
   `client.test.ts`: use injected Fetch responses to assert exact HTTP method/path/body, string ID
   confinement for PUTs, caller abort forwarding, rejection before transport, collection/depth
   bounds, duplicate identities, fresh frozen copies, and sanitized typed errors. Extend
   `generated-contract.test.ts` only to pin the already-committed operations and generated request
   envelopes needed by the feature.
3. **Action tests** in
   `packages/rfmedia-cli/src/actions/lidarr/profile-presets.test.ts`: extend
   `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts` with typed defaults, then
   mock the scheduler/resolvers with `vi.hoisted` as in
   `actions/lidarr/plan-artist-profiles.test.ts`. Assert complete preflight before writes, exact
   write order (custom formats, refreshed catalogs, profiles, naming), fresh drift checks,
   read-back verification, origin-lock lifetime, stop-admission behavior, journal durability,
   uncertain classification, cancellation cleanup, zero writes/lock-authorized journal writes in
   dry-run, and zero writes on the converged second run.
4. **Command tests** in `packages/rfmedia-cli/src/commands/lidarr.test.ts` or a focused
   `lidarr-presets.test.ts`: mock lazy actions and formatters; assert the exact four-command tree,
   offline list/show, one prompt only when changes remain, non-TTY/machine `--yes` enforcement,
   default-no cancellation, human stderr, single machine stdout envelope, fixed-row CSV columns,
   redaction, and exit codes.
5. **Config tests** in `packages/rfmedia-cli/src/lib/config.test.ts`: prove absence is backward
   compatible and configured packs reject unknown keys, unsafe YAML shapes, excessive
   depth/count/size, invalid references, unsafe regex/naming values, and built-in shadowing.
6. **Completion parity** in
   `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: update
   `bash.ts`, `zsh.ts`, and `fish.ts` together; lock the `presets list|show|diff|apply` hierarchy,
   exact leaf options/value positions, and the no-config/no-client/no-Fetch side-effect invariant.
7. **Architecture and package gates**: run `check:architecture`, `test:architecture`,
   `codegen:lidarr:check`, focused Vitest files, typecheck, build, and `git diff --check`. Do not
   refresh generated code unless the generated-contract test demonstrates a missing operation.

Temporary filesystem tests should use `mkdtemp` and remove only their own roots in `afterEach`, as
in `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.test.ts`. Prefer the typed facade
mock over broad `as unknown` casts, assert mutations were not called in every read-only/dry-run
case, and verify deterministic order explicitly rather than relying only on snapshots.

## Patterns to Follow

1. Create the frozen generated-independent contracts first, then pure pack validation/diff logic,
   then rich projectors/facade methods, then live actions, then the command/presentation layer.
2. Implement `commands/lidarr-presets.ts` as a DI sibling factory and register exactly one
   `presets` subtree from `commands/lidarr.ts`.
3. Keep built-ins local, immutable, versioned, and validated by the same pure validator as
   configured packs; do not introduce remote content, inheritance, or a generic reconciliation
   framework.
4. Treat every live response as hostile `unknown`; reject malformed whole authorization state
   rather than truncating it, and preserve order only where Lidarr behavior makes it significant.
5. Build profile PUT bodies from a fresh catalog so every current custom format appears exactly
   once and every undeclared live score survives.
6. Acquire a dedicated canonical-origin claim only for real apply, recheck drift before every
   write, verify each write by fresh semantic read-back, durably record the outcome, and stop later
   admissions on stale, failed, uncertain, or non-durable results.
7. Preserve presentation parity: bounded accessible human stderr, versioned JSON/YAML stdout, and
   explicit spreadsheet-safe fixed-column CSV rows.
8. Change Bash, Zsh, Fish, parity tests, help/docs, example config, architecture contracts, and the
   typed mock seam together with the command/API surface.
