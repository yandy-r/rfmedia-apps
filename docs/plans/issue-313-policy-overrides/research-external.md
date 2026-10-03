# External API Research: Policy Decision Overrides

## Executive Summary

Issue #313 does not require a new external API, authentication flow, network call, SDK, or paid
service. The override is operator-authored local state applied to an already-materialized policy
evaluation report. Plex and Lidarr remain evidence sources through the existing gather path; the
override layer should perform no provider I/O. **Confidence**: High — confirmed by the issue scope
and the current evaluator, proposal, and pure policy-plan boundaries.

The repository already has the two required platform capabilities: `.rfmedia.yaml` is parsed with
the existing `js-yaml` dependency and `CORE_SCHEMA`, and the supported Node.js 22 runtime includes
`node:crypto` SHA-256 hashing. No dependency should be added. **Confidence**: High — confirmed by
the package manifest and configuration loader, plus current upstream documentation.

Keep the current stable decision key as the durable lookup key, and store a separate, versioned
fingerprint of the decision facts whose change makes an entry stale. Hash a deterministic data
projection, not YAML source text and not the entire report. **Confidence**: High — the current key
is explicitly non-rotating, while RFC 8785 documents why hashing requires invariant serialization.

## Primary APIs

| Integration             | New use for #313                             | Authentication                 | Endpoints | Limits / pricing |
| ----------------------- | -------------------------------------------- | ------------------------------ | --------- | ---------------- |
| Plex                    | None; existing gathered policy evidence only | Existing rfmedia configuration | None      | Not applicable   |
| Lidarr                  | None; existing gathered policy evidence only | Existing rfmedia configuration | None      | Not applicable   |
| Remote override service | Not recommended                              | None                           | None      | Not applicable   |

The current decision already carries a stable key, before/after state, ordered threshold checks,
and observations (`packages/rfmedia-cli/src/types/lidarr-policy.ts:240-288`). The policy-plan
projector is explicitly pure and performs no I/O
(`packages/rfmedia-cli/src/lib/bridge/policy-plan.ts:1-6`). An override matcher can therefore be a
pure transformation between evaluation and presentation/projection. **Confidence**: High.

## Libraries and SDKs

### `js-yaml` 4.3.0 — reuse

The CLI already depends on `js-yaml` 4.3.0 and loads YAML with `CORE_SCHEMA`
(`packages/rfmedia-cli/package.json:45-55`, `packages/rfmedia-cli/src/lib/config.ts:4682-4689`).
The upstream 4.3.0 documentation says `load()` parses one YAML document and exposes schema
selection; its tag was committed on 2026-06-26. No second parser or schema package is justified.
**Confidence**: High.

Official documentation:

- [js-yaml 4.3.0 README](https://github.com/nodeca/js-yaml/blob/4.3.0/README.md)
  (tag 4.3.0, 2026-06-26)

### Node.js `node:crypto` — reuse

Node.js documents `createHash()`, `hash.update()`, and `hash.digest()`, including SHA-256 and hex
output. The package requires Node.js 22 or newer, so this is a built-in runtime API rather than a
dependency. **Confidence**: High.

Official documentation:

- [Node.js 22 `crypto.createHash`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreatehashalgorithm-options)
  (v22.23.2 documentation snapshot, accessed 2026-08-06)
- [Node.js 22 `Hash` update/digest example](https://nodejs.org/docs/latest-v22.x/api/crypto.html#class-hash)
  (v22.23.2 documentation snapshot, accessed 2026-08-06)

### Canonical JSON library — do not add

RFC 8785 defines invariant JSON serialization through deterministic property sorting, primitive
serialization, and UTF-8 generation. It is a useful design reference, but a general JCS package is
unnecessary for this feature: the evidence envelope is small and can be projected into explicitly
ordered arrays of scalars before `JSON.stringify()`. **Confidence**: High for no new dependency;
Medium for the exact projection until the domain team fixes which fields constitute staleness.

Official specification:

- [RFC 8785: JSON Canonicalization Scheme](https://datatracker.ietf.org/doc/html/rfc8785)
  (June 2020; informational RFC)

## Integration Patterns

### 1. Reviewable YAML mapping keyed by decision key

Use `policy.overrides` as a mapping whose quoted keys are the existing decision keys. YAML 1.2.2
defines mappings as unordered associations with unique keys, which fits lookup semantics and makes
duplicate entries invalid rather than order-dependent. Quoting avoids visual ambiguity around the
colons in keys. **Confidence**: High.

```yaml
policy:
  overrides:
    "stale-monitoring-cleanup:artist:42":
      action: suppress
      evidence: "sha256:5bd8..."
      reason: "Live album retained after operator review"
```

Official specification:

- [YAML 1.2.2](https://yaml.org/spec/1.2.2/) (October 2021), especially mappings
  as unordered collections with unique keys.

### 2. Separate stable identity from change-sensitive evidence

Retain `<ruleId>:artist:<lidarrId>` and `<ruleId>:plex:<plexId>` as the lookup key; these builders
already exist in `policy-rule-support.ts:67-79`. Skip keys additionally carry the skip code at
`policy-rule-support.ts:230-257`, so the validator must not assume every key has exactly three
segments. Add a separate fingerprint with an algorithm/version prefix such as `sha256:` plus a
schema version in the hashed data. **Confidence**: High.

The fingerprint should include semantic decision facts: key, decision/skip code, before/after,
ordered checks (including observed value and bound), and observations with sorted signal names.
Exclude volatile or presentational fields such as `evaluatedAt`, report origins, summary/detail
prose, artist display names, and handoff formatting. **Confidence**: Medium — this is the safest
projection inferred from current types, but whether threshold-bound changes count as stale is a
domain decision.

### 3. Apply once before every downstream consumer

Classify each current decision as ordinary, suppressed, overridden, or stale in a pure layer, then
feed the same classified result to human/JSON/CSV output, `--explain`, policy-plan projection, and
rating-sync projection. This prevents a row from appearing suppressed in presentation while still
reaching a plan consumer. **Confidence**: High — current plan projection consumes report proposals
directly (`policy-plan.ts:317-329`).

Stale entries must never silently apply their old action. They should remain visible with both
stored and current fingerprints. Whether the underlying proposal remains plan-eligible or is
quarantined pending review is a safety policy that must be decided explicitly. **Confidence**:
High for visible/inert stale treatment; Low for plan eligibility because the issue leaves it open.

### 4. Preserve the no-mutation boundary

Fingerprinting, matching, and rendering are synchronous local computations. They need no
`LidarrClientApi` method and should not write an override store during evaluate. Editing the YAML
file is an operator action outside evaluation; `policy evaluate` only reads it. **Confidence**:
High.

## Constraints and Gotchas

- Do not hash YAML bytes. YAML mapping order, quoting style, indentation, and comments are
  presentation details, so harmless edits would create false staleness. **Confidence**: High — YAML
  1.2.2 explicitly treats mapping order as non-semantic.
- Do not hash the full evaluation report. Timestamps and display text rotate independently of the
  decision evidence. **Confidence**: High — verified from the current report model.
- Version the fingerprint projection independently from the policy engine schema. A future field
  addition must not reinterpret old hashes silently. **Confidence**: High.
- Validate override action, evidence format, reason bounds, decision-key grammar, and unknown
  fields fail-closed, following the existing exact-key config validation at
  `config.ts:2808-2819` and `config.ts:3108-3129`. **Confidence**: High.
- YAML mappings are unordered. Override precedence must come from explicit semantics, never file
  order. **Confidence**: High.
- A cryptographic hash here is a deterministic change detector, not authentication. No secret key,
  HMAC, signing system, or credential storage is needed. **Confidence**: High.

## Code Examples

Illustrative dependency-free fingerprinting pattern:

```ts
import { createHash } from "node:crypto";
import type { PolicyProposal } from "../../types/lidarr-policy.js";

function sortedEntries<T>(record: Readonly<Record<string, T>>): readonly (readonly [string, T])[] {
  return Object.keys(record)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => [key, record[key] as T] as const);
}

export function policyEvidenceFingerprint(proposal: PolicyProposal): string {
  const canonical = JSON.stringify([
    "rfmedia-policy-evidence-v1",
    proposal.key,
    proposal.code,
    sortedEntries(proposal.before),
    sortedEntries(proposal.after),
    proposal.checks.map((check) => [
      check.signal,
      check.comparator,
      check.bound,
      check.observed,
      check.satisfied,
      check.configPath,
    ]),
    sortedEntries(proposal.observations),
  ]);

  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
```

Production code should freeze the exact projection contract in tests, including property-order
independence, play/rating changes, threshold changes, and exclusion of timestamps and display
prose. **Confidence**: High.

## Open Questions

1. Does `action: override` mean an alternate inert verdict, an alternate desired value, or only an
   operator acknowledgement? Its payload and plan behavior cannot be derived from external APIs.
2. Does a changed configured threshold stale an entry, or only changed observed evidence? Include
   bounds in the fingerprint only if policy-context changes require re-review.
3. When an override is stale, should the original proposal remain plan-eligible or be quarantined
   until the operator refreshes/removes the entry? Quarantine is safer but changes workflow.
4. May operators dispute skip/refusal rows, or only proposals? Current skip keys are stable and
   unique, but suppressing a refusal must never manufacture an actionable proposal.
5. Should reasons be mandatory for auditability, and what length/control-character limits apply?

## Source Freshness

- GitHub issue #313: created and last updated 2026-07-31; inspected 2026-08-06.
- Repository policy implementation: commit `79d8e8c38d2ca9862268b778fa65fc4ef480801b`
  dated 2026-07-31; inspected 2026-08-06.
- js-yaml 4.3.0 upstream tag: 2026-06-26.
- Node.js documentation: v22.23.2 snapshot accessed 2026-08-06.
- YAML 1.2.2: October 2021. Stable format specification; no freshness concern.
- RFC 8785: June 2020. Stable canonicalization specification; no freshness concern.
