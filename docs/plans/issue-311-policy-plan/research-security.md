# Security Research — Lidarr Policy Plan

## Executive Summary

Issue #311 needs no new artifact format, mutation API, credential path, or runtime dependency. It
should compose the shipped evaluator with the existing `artist-profile-assignment` and
`artist-monitoring` producers. Default behavior must be artifact-free review; an explicit seal mode
may create strict `rfmedia.lidarr-plan.v3` files, but this command must never apply them.

Two controls are release-blocking. First, evaluation evidence explains a recommendation; it does
not authorize either artifact creation or mutation. Second, every selected proposal must pass a
global fail-closed preflight before the first producer call. Unsupported discovery, malformed
targets, handoff mismatch, unknown producers, unsafe cross-producer combinations, or oversized
cohorts must prevent all sealing rather than silently shrink the artifact set.

Existing producers provide the correct TOCTOU boundary: they re-read Lidarr, seal fresh `before`
state, and use the hardened private writer. Apply remains separate, pins both plan ID and checksum,
checks target origin, and revalidates live state. The SHA-256 checksum detects payload changes; it
is neither a signature nor authorization.

**Confidence**: High — based on issue #311, the #209 design, `sync-ratings`, both producers, plan
storage/validation, and apply preflight reviewed on 2026-07-31.

## Findings by Severity

### CRITICAL

#### C1 — Policy evidence must not become mutation authorization

`PolicyEvaluationReport` and `handoff.argv` are recommendation data. Executing argv, adding an
apply mode, or treating API-key possession as approval would collapse the
evaluate → review → seal → apply boundary.

Required constraints:

- Default to review and require an explicit mode value to seal.
- Never call `executeLidarrApply`, a mutation method, or an argv executor from policy-plan code.
- Show a next command only after sealing, using the returned path, ID, and checksum.
- Keep policy evidence outside the strict artifact envelope and preserve `policy evaluate` without
  plan-producer imports or plan-directory writes.

**Confidence**: High — this boundary is explicit in issues #209/#311 and existing apply design.

#### C2 — An unaccounted proposal can authorize the wrong subset

A silently dropped proposal produces a valid-looking but incomplete plan. Compile-time unions do
not protect future schema drift, mocks, or malformed runtime values.

Required constraints:

- Project and validate every selected proposal before any producer call. If one cannot project,
  explicit seal mode writes zero artifacts.
- Cross-check rule, decision code, descriptor producer, `handoff.producer`, authoritative identity,
  positive `subject.artistId`, and the required typed `after` scalar.
- Refuse `discovery`; never reinterpret it as `artist-add` or use argv as identity/state authority.
- Group by producer and desired target; sort/deduplicate IDs; reject contradictions and unsafe
  same-artist cross-producer combinations.
- Bind `maxBatch` to cohort size and reject empty or over-cap cohorts before I/O.

**Confidence**: High — `rating-sync.ts` already makes malformed projection a hard failure.

### WARNING

#### W1 — Evaluation state can be stale before sealing

Copying proposal `before` values into an artifact is a TOCTOU flaw.

Required constraints:

- Pass only validated IDs and desired scalar targets to existing producers; they own fresh reads
  and plan construction.
- Bind profiles by numeric ID, not display name.
- Fail on missing artists, unresolved profiles, origin changes, or producer validation errors.
  Never fall back to evaluation state or stale cache.
- Keep evaluation evidence distinct from sealed state; retain apply's drift and origin preflight.

**Confidence**: High — producers and apply independently re-read live Lidarr state.

#### W2 — Multiple artifact writes are not transactional

Artifact two can fail after artifact one is durable despite successful global projection preflight.

Required constraints:

- Seal sequentially in declared producer order.
- Capture each outcome immediately. A later failure must preserve earlier path, ID, and checksum in
  a typed partial result; prose-only error reporting is insufficient.
- Never delete a sealed artifact as rollback. Machine output must distinguish partial from failed,
  and partial completion must exit nonzero. No apply occurs.

**Confidence**: High — current producers perform independent filesystem writes.

#### W3 — Integrity and path safety must remain producer-owned

The existing writer verifies exact keys and checksum, rejects sensitive keys, unsafe/symlinked or
shared-writable paths, uses private permissions, and prevents overwrite.

Required constraints:

- Reuse producer default paths in v1; do not accept one ambiguous `--plan-file` for two outputs.
- Do not add a serializer, checksum implementation, overwrite path, or symlink-following path.
- Report only producer-returned resolved path, UUID, and checksum. Pin both ID and checksum on apply.
- Document that an attacker able to replace and reseal a plan defeats an unkeyed checksum.

**Confidence**: High — these controls are implemented in `plan-engine.ts` and apply.

#### W4 — Errors and reports can leak secrets or library metadata

Overrides contain credentials; reports contain origins, library/artist names, Plex IDs, MBIDs,
thresholds, paths, and handoff values. Artifacts also include host, user, and working directory.

Required constraints:

- Pass raw Plex token and Lidarr API key to the shared failure redactor. Never serialize options,
  headers, environment/config objects, credentials, or raw upstream errors.
- Keep human output on stderr and one complete machine document on stdout. Represent partial state
  inside the envelope rather than streaming invalid JSON fragments.
- Preserve terminal/bidi and length validation. Document machine reports/artifacts as sensitive
  operational metadata.
- Preserve raw cross-origin override handling so stored credentials cannot unlock a changed origin.

**Confidence**: High for redaction; Medium for downstream log retention outside the CLI.

### ADVISORY

#### A1 — Keep orchestration narrow

Do not wrap evaluation and producers in another scheduler slot; nested `local-only` acquisition can
deadlock at concurrency one. Freeze result collections, use stable refusal codes, and require an
explicit projector or refusal for every future rule/producer through exhaustive maps.

**Confidence**: High — this matches shipped `sync-ratings` composition.

## Dependency Security

No new dependency is required. Node crypto/filesystem primitives, Commander, the existing policy
engine, generated Lidarr facade, producers, writer, and apply validator cover the feature. Adding
an SDK, shell executor, schema library, or serializer would expand injection and supply-chain risk
without adding capability. Dependency risk is unchanged from the repository baseline.

**Confidence**: High — this is local orchestration over existing exports.

## Required Security Tests

- Default review never calls a producer, writer, apply action, or mutation client method.
- Discovery, unknown producer, descriptor/code mismatch, non-authoritative identity, invalid artist
  ID, wrong target type, contradictory target, cross-producer conflict, and over-cap cohort each
  cause zero producer calls in seal mode.
- When evaluation `before` differs from live state, the artifact contains producer-fetched state;
  missing artist/profile and origin mismatch fail closed.
- No argv execution/apply call exists; next commands pin exact returned ID and checksum.
- If producer one seals and producer two fails, the first outcome survives, status is partial, exit
  is nonzero, and no cleanup or apply occurs.
- Existing-path, unsafe-parent, symlink, control-path, checksum, sensitive-key, and overwrite tests
  retain writer failures.
- Canary credentials are absent from human and JSON/YAML/CSV errors; stdout stays one document.
- Existing evaluate, producer, plan-engine, apply, and Bash/Zsh/Fish parity tests remain green.

## Open Questions

1. Seal syntax: recommend `--mode recommend|plan`, default `recommend`, with no apply value.
2. Refusal behavior: review may report refusals successfully; explicit seal should fail globally
   until the user narrows the rules or resolves every selected proposal.
3. Partial result shape: return completed outcomes plus sanitized failure metadata.
4. Cross-producer overlap: conservatively withhold both proposals in v1; relax only through an
   explicit compatibility rule and tests.
