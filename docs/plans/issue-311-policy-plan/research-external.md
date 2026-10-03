# External Research: Lidarr Policy Plan

## Executive Summary

Issue #311 does not require a new network API, SDK, artifact format, or runtime dependency. The
existing `artist-monitoring` and `artist-profile-assignment` plan producers already perform the
necessary fresh Lidarr reads and seal strict `rfmedia.lidarr-plan.v3` artifacts. The new command
should orchestrate those producers from typed `PolicyProposal` data, not reproduce their Lidarr
calls or plan-writing logic.

The safest external-integration shape is the established `sync-ratings` ladder: default to a
review-only `recommend` mode, require an explicit `plan` mode to call producers, and keep apply
outside this verb. Before the first artifact write, project every selected proposal through a
closed producer map, validate the producer/rule/target agreement, and surface every unsupported
projection as a refusal. In particular, `discovery` is intentionally inert and has no plan
producer; it must never be silently discarded or reinterpreted as `artist-add`.

Plan contents and checksum handling should remain wholly owned by the existing producer and plan
engine. Policy evidence belongs in the command result alongside the generated artifact metadata,
not in the closed v3 artifact envelope. A later apply remains pinned by the generated plan's `id`
and `payloadChecksum`.

**Confidence**: High. The conclusion is supported by the shipped #209 contract, the two existing
producers, the generalized `sync-ratings` composition, and the current official Lidarr API; no
missing upstream operation blocks the feature.

## Primary APIs

### Lidarr v1 reads already owned by the producers

The current official [Lidarr API reference](https://lidarr.audio/docs/api/) (retrieved 2026-07-31,
generated from the `develop` OpenAPI document) exposes the reads needed by the shipped producers:

| Method | Endpoint                  | Existing use in policy planning                                              |
| ------ | ------------------------- | ---------------------------------------------------------------------------- |
| `GET`  | `/api/v1/artist`          | Re-read exact artist IDs and seal current monitoring/profile state.          |
| `GET`  | `/api/v1/qualityprofile`  | Resolve and seal the numeric target quality profile.                         |
| `GET`  | `/api/v1/metadataprofile` | Existing profile producer support; not required by today's policy proposals. |

Current official controller source is available at Lidarr `develop` commit
[`d88cbcec`](https://github.com/Lidarr/Lidarr/commit/d88cbcec050c04b3064c9f36221edac152e241e2)
(2026-07-28):
[ArtistController](https://github.com/Lidarr/Lidarr/blob/d88cbcec050c04b3064c9f36221edac152e241e2/src/Lidarr.Api.V1/Artist/ArtistController.cs),
[QualityProfileController](https://github.com/Lidarr/Lidarr/blob/d88cbcec050c04b3064c9f36221edac152e241e2/src/Lidarr.Api.V1/Profiles/Quality/QualityProfileController.cs),
and
[MetadataProfileController](https://github.com/Lidarr/Lidarr/blob/d88cbcec050c04b3064c9f36221edac152e241e2/src/Lidarr.Api.V1/Profiles/Metadata/MetadataProfileController.cs).
Those controller files were last changed together on 2025-10-15.

`policy plan` itself should call no Lidarr endpoint directly. In explicit seal mode it should call
`executeLidarrPlan` or `executeLidarrArtistProfilePlan`, which already resolve the configured
origin, use the hardened generated-client facade, disable mutation retries, read fresh state, and
write the sealed artifact. The default review mode should stop before both producer calls.

**Confidence**: High. The official API and the repository's immutable OpenAPI snapshot agree on
these collection endpoints. The local snapshot pins Lidarr commit
[`3e285843`](https://github.com/Lidarr/Lidarr/commit/3e2858439ff35b372d0af00bcea1b0a357572d26)
(2025-10-20), while the current controller sources show no relevant endpoint drift.

### No mutation API in this command

Sealing a plan is local artifact I/O, not a Lidarr mutation. The new action should not use
`PUT /api/v1/artist/editor`, `PUT /api/v1/artist/{id}`, or any apply API. That preserves the
reconciliation boundary: evaluation evidence proposes a change, a producer seals fresh current
state, and a separate reviewed `lidarr apply` authorizes the mutation.

**Confidence**: High. This follows the existing plan/apply contract and issue #311's explicit
non-mutation scope.

## Libraries and SDKs

### Existing generated Lidarr client

The repository already pins `@hey-api/openapi-ts@0.93.0` and commits a private generated Fetch SDK
from the immutable Lidarr snapshot. The handwritten `LidarrClient` facade already exposes the list
operations consumed by both producers. No code generation refresh and no second Lidarr SDK are
needed.

Adding another SDK would duplicate authentication, origin checking, cancellation, response bounds,
and error mapping while providing no new endpoint. Keep generated files private and reuse the
existing action exports.

**Confidence**: High. All required operations and facade methods are present in the checked-in
client, and the current official API adds no required capability.

### Commander

The package already uses Commander 14. Commander supports nested subcommands and adding a separately
configured command with `.addCommand()`, so `policy plan` fits the existing `policy` parent without
a parser dependency or executable shim. See the official
[Commander documentation](https://github.com/tj/commander.js/tree/v14.0.3#commands) for v14.0.3
(released 2026-01-31).

Follow the repository's existing manual value validation rather than introducing a validation
library: it keeps errors inside the standard structured failure envelope.

**Confidence**: High. This is a documented Commander capability and matches the shipped command
construction pattern.

### Node.js checksum and filesystem primitives

Node 22 already supplies SHA-256 through `node:crypto` and exclusive, no-follow file operations
through `node:fs`. The existing plan engine uses those built-ins to canonicalize, hash, validate,
and privately write artifacts. Official references are
[`crypto.createHash`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreatehashalgorithm-options)
and the [file-system API](https://nodejs.org/docs/latest-v22.x/api/fs.html) for Node 22.23.1
(released 2026-06-23; documentation retrieved 2026-07-31).

The new feature should not compute a second checksum, serialize an artifact itself, or add a stable
JSON package. It should return the `id` and `payloadChecksum` produced by the existing plan engine.

**Confidence**: High. The required primitives are in the supported runtime and are already wrapped
by repository code with stronger artifact-specific invariants.

## Integration Patterns

### Closed, typed proposal projection

Use a total projection table keyed by `PolicyProducerId`. Each projector reads structured proposal
fields and produces structured arguments for one existing action:

| `handoff.producer`          | Required proposal facts                                          | Existing action                    |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| `artist-profile-assignment` | positive `subject.artistId`; numeric `after["qualityProfileId"]` | `executeLidarrArtistProfilePlan`   |
| `artist-monitoring`         | positive `subject.artistId`; boolean `after["monitored"]`        | `executeLidarrPlan`                |
| `discovery`                 | no Lidarr target by design                                       | explicit unsupported/inert refusal |

Cross-check `handoff.producer` against the rule descriptor and, where useful, the inert argv's
declared command shape. Do not execute the argv and do not make argv parsing the source of target
values; it is review output, while `subject` and `after` are the typed projection contract.

**Confidence**: High. This preserves the #209 handoff seam while avoiding a shell/parser boundary.

### Preflight, then seal

1. Run the existing evaluate action once and retain its frozen report unchanged.
2. Project every selected proposal in memory, including explicit refusals.
3. Validate all sealable cohorts before the first producer call: supported producer, required
   scalar type, unique positive IDs, one desired target per cohort, and bounded cohort size.
4. In default `recommend` mode, render/serialize the evaluation, projections, and refusals and stop.
5. In explicit `plan` mode, seal cohorts sequentially in `POLICY_PRODUCER_IDS` declaration order.
6. Return one outcome per artifact with producer, rule(s), path, plan ID, and checksum. Present the
   pinned next step, but do not apply.

Preflighting avoids writing an artifact and only later discovering an unsupported proposal. Runtime
producer or filesystem failure can still leave a deterministic prefix of artifacts, so each
successful seal should be reported immediately and the result/error should identify partial output.

**Confidence**: High for preflight and ordered sealing; Medium for the exact partial-failure result
shape because issue #311 has not fixed that public union yet.

### Cohort grouping

Group by producer and desired target, not merely by rule name. Monitoring proposals with different
desired booleans and profile proposals with different target IDs cannot share one artifact. Sort and
deduplicate IDs before producer invocation, and bind `maxBatch` to the actual cohort size, as
`sync-ratings` does; the policy engine allows up to 100 proposals per rule while producer defaults
to 25.

**Confidence**: High. The existing artifact operations carry one desired monitoring state or one
resolved profile target per plan, and both producers reject inconsistent or oversized selections.

### Artifact review and checksum pinning

Reuse the v3 artifact unchanged. Policy checks, observations, summary, and decision keys remain in
the policy-plan result; adding them to the artifact would break its exact-key validator and checksum
contract. A displayed next step should pin both values returned by the producer:

```text
rfmedia lidarr apply <plan-path> --expected-plan-id <id> \
  --expected-plan-checksum <sha256:...>
```

**Confidence**: High. This is the shipped plan/apply interface and avoids an unnecessary artifact
version change.

## Constraints and Gotchas

- **Discovery is deliberately not a mutation producer.** A `discovery` proposal has no
  `subject.artistId` and cannot be converted to `artist-add` without crossing the Last.fm ownership
  and provenance boundaries. It needs an explicit refusal, never a silent drop. **Confidence**:
  High.
- **The default must remain artifact-free.** Calling either producer always writes a sealed file;
  therefore review mode must not call a producer with a `dryRun` convention that the producers do
  not implement. **Confidence**: High.
- **Validate all projections before sealing.** A mismatched rule/producer, missing artist ID,
  wrong target type, unknown future producer, or conflicting target must fail closed. Merely
  switching on `handoff.producer` and trusting the rest of the object is insufficient.
  **Confidence**: High.
- **Fresh state may differ from evaluation state.** Producers intentionally re-read Lidarr before
  sealing, so the artifact's `before` state is authoritative for apply even if the policy report is
  older by milliseconds. Keep both views visible and never copy the proposal's `before` directly
  into an artifact. **Confidence**: High.
- **Multiple artifacts are not transactional.** Sequential sealing gives deterministic partial
  output but no all-or-nothing filesystem transaction. Report every completed path/checksum as it
  is produced. **Confidence**: High.
- **A numeric profile ID is the safe binding.** Passing the proposal's display name can become
  ambiguous; pass `String(after["qualityProfileId"])` to the existing resolver, matching the
  `sync-ratings` precedent. **Confidence**: High.
- **Do not nest a scheduler slot.** Both evaluation and producers already schedule their own work;
  a wrapper `runSingle` can deadlock when local concurrency is one. **Confidence**: High.
- **Completions are three independent static surfaces.** Commander help does not update the checked-in
  Bash, Zsh, and Fish templates. All three plus their parity tests must change together.
  **Confidence**: High.

## Code Examples

Illustrative projection only; names should follow the final local type design:

```ts
const PROJECTORS = {
  "artist-profile-assignment": (proposal: PolicyProposal) => {
    const artistId = requirePositiveArtistId(proposal.subject.artistId, proposal.key);
    const qualityProfileId = requireNumber(proposal.after["qualityProfileId"], proposal.key, "qualityProfileId");
    return {
      producer: "artist-profile-assignment" as const,
      groupKey: `artist-profile-assignment:${qualityProfileId}`,
      artistId,
      qualityProfileId,
    };
  },
  "artist-monitoring": (proposal: PolicyProposal) => {
    const artistId = requirePositiveArtistId(proposal.subject.artistId, proposal.key);
    const monitored = requireBoolean(proposal.after["monitored"], proposal.key, "monitored");
    return {
      producer: "artist-monitoring" as const,
      groupKey: `artist-monitoring:${monitored}`,
      artistId,
      monitored,
    };
  },
} satisfies Readonly<Record<PolicyProducerId, PolicyProjector>>;

function projectProposal(proposal: PolicyProposal): PolicyProjection {
  const producer = proposal.handoff.producer;
  const declared = POLICY_RULE_DESCRIPTORS[proposal.ruleId].producer;
  if (producer === "discovery") {
    return unsupportedRefusal(proposal, "discovery is review-only and has no Lidarr plan producer");
  }
  if (producer !== declared) {
    throw new PolicyProjectionError(proposal.key, "handoff producer disagrees with rule descriptor");
  }
  return PROJECTORS[producer](proposal);
}
```

Producer dispatch should remain structured and preserve the numeric target:

```ts
if (cohort.producer === "artist-profile-assignment") {
  return executeLidarrArtistProfilePlan({
    artistIds: cohort.artistIds,
    qualityProfile: String(cohort.qualityProfileId),
    maxBatch: cohort.artistIds.length,
    ...connection,
  });
}

return executeLidarrPlan({
  artistIds: cohort.artistIds,
  monitored: cohort.monitored,
  maxBatch: cohort.artistIds.length,
  ...connection,
});
```

## Open Questions

1. In explicit `plan` mode, does any unsupported proposal block **all** artifact writes after
   preflight, or may supported cohorts seal while the result carries refusals? “Fail closed” favors
   all-or-none preflight, but a default-selected discovery seed would otherwise require a rule
   filter before any sealing run.
2. Should the mode vocabulary be exactly `recommend|plan`, matching `sync-ratings` while omitting
   its apply rung, or should the command use a different explicit seal flag? A value-taking mode
   provides the clearest completion and documentation contract.
3. If one artist appears in both supported producer cohorts, may both independent artifacts be
   sealed, or should the command inherit `sync-ratings`' cross-decision refusal? The operations
   touch different fields, but apply order and stale-state review semantics need a binding answer.
4. When several target-specific cohorts exist for one producer, how should an explicit output path
   be interpreted: directory, filename prefix, or refusal? Producer-default unique paths avoid
   accidental overwrite but offer less operator control.
5. What status should a proposal receive when the producer re-read finds the target already
   converged: a successful zero-change review result, a refusal, or a producer validation error?
6. Should the result schema embed the full evaluation report, as `sync-ratings` does, or reference
   it through a smaller projection while retaining enough policy evidence for review and
   `--explain`?
