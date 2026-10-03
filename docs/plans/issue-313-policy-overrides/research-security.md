# Security Research: Policy Decision Overrides

## Executive Summary

Issue #313 can safely ship as a local, configuration-backed, **suppression-only** feature. A
configured disposition may remove a current proposal from consideration, but it must never create
a proposal, replace desired state, bypass an identity/signal refusal, seal an artifact by itself, or
call a mutation API. Active and stale disputes must both fail closed before the shared proposal
collection reaches `policy plan` or `sync-ratings`.

The most important repository-specific hazard is config loading: `loadConfig()` currently catches
YAML/JSON parse and `ConfigError` failures and continues to a lower-priority file or empty config.
That behavior is unsafe for a durable suppression because a malformed entry could disappear and a
subsequent `sync-ratings --mode apply` could proceed. Override-bearing policy runs need strict,
fatal config loading (or an independently strict override loader) before this feature ships.

## Findings by Severity

### CRITICAL — Hard Stops

| Finding                                                                                                        | Risk                                                                                                                                                                                                                                                            | Required Mitigation                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1. A `force`, `allow`, `propose`, or operator-supplied `after` action would be an unsafe privilege escalation | It could manufacture a mutation from a skip, bypass the branded authoritative-identity gate, override live `before` state, or turn an inert discovery seed into a Lidarr write.                                                                                 | V1 accepts exactly `action: suppress`. It only acts on an existing proposal key and never changes a proposal payload. Any future force workflow requires a separate reviewed design and sealed-plan approval path.                                                                                                      |
| C2. Presenter-only or fail-open disposition logic can bypass a dispute                                         | A row could appear suppressed while remaining in `report.proposals`, which both policy-plan and rating-sync project into sealable/applyable cohorts. Allowing a stale match through has the same effect after evidence changes.                                 | Apply dispositions once in the pure engine after rule caps and before the final actionable proposal array. Remove both active and stale matches from `report.proposals`; preserve them in a distinct override-results collection. Do not refill a capped cohort after removal.                                          |
| C3. Current config fallback can silently erase all overrides                                                   | `loadConfig()` catches parse/validation failures and falls through. A typo, duplicate YAML key, malformed fingerprint, or unsafe object can therefore select lower-priority/empty config; `sync-ratings` may then force-enable an unset rule and mutate Lidarr. | Policy evaluate/plan and sync-ratings must use strict config semantics: the highest-precedence existing file either parses and validates completely or the command exits before gathering, sealing, prompting, or applying. A feature-specific strict loader is acceptable if changing global behavior is out of scope. |

- C1 — **Confidence**: High. Current proposal construction deliberately requires an authoritative
  identity brand, skips have no mutation handoff, and sync-ratings can apply projected proposals.
- C2 — **Confidence**: High. `projectPolicyPlan()` and `buildRatingSyncPlan()` consume the evaluation
  report, while `sync-ratings.ts` owns the actual plan/apply ladder.
- C3 — **Confidence**: High. The behavior is explicit in `config.ts` and its tests: parse and
  `ConfigError` failures warn and continue to the next search path.

### WARNING — Must Address

| Finding                                                                       | Risk                                                                                                                                                                                                                                                                                    | Suggested Mitigation                                                                                                                                                                                                                                          | Alternatives                                                                                                                                  |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| W1. Ad hoc fingerprint serialization creates false matches or false staleness | Raw `JSON.stringify()` depends on construction order; omitted `undefined`, non-finite numbers, Unicode edge cases, unordered records, or a changed projection can confuse review state. Hash collision is far less likely than canonicalization error.                                  | Hash a small, explicit, versioned projection using recursive deterministic key ordering, preserved array order, UTF-8, finite JSON values, and SHA-256. Publish golden vectors and bump the fingerprint schema whenever semantics change.                     | Use a maintained RFC 8785 implementation, but that adds supply-chain surface unnecessary for this bounded shape.                              |
| W2. A key is not globally scoped                                              | Lidarr numeric IDs and Plex rating keys are instance-local and can be reused after delete/re-add, across origins, or across libraries. A global config may otherwise suppress an unrelated but similarly shaped proposal.                                                               | Bind `plexOrigin`, `lidarrOrigin`, and `plexLibrary` into the fingerprint along with key, subject IDs/MBID, identity basis, code, before/after, checks, observations, and producer. Any scope change becomes stale.                                           | Store scope beside each override and require an exact scope match before checking the evidence hash.                                          |
| W3. Arbitrary config maps expose prototype/confusion and resource risks       | Assigning `__proto__` into `{}`, inherited `constructor`/`prototype` properties, getters, oversized maps, or coercing malformed objects can change lookup behavior, exhaust output, or throw outside the intended `ConfigError` contract.                                               | Require ordinary or null-prototype objects, inspect own enumerable keys only, reject prototype-like keys, build a `Map` or null-prototype result, cap entries and UTF-8 byte lengths, and use `describeType()` rather than `String(value)` on unknown values. | Use an array and reject duplicate keys after parsing; this is safer for JSON duplicate detection but less ergonomic.                          |
| W4. Override reasons are an output and log injection surface                  | Reasons flow to human, JSON/YAML, CSV, nested policy-plan, and sync-ratings output. Controls/bidi characters can forge terminal lines; secrets or private listening context can leak into CI artifacts. Config-wide secret interpolation makes a templated reason especially dangerous. | Require a bounded, trimmed, control-free and bidi-free reason. Treat it as a public annotation, document “no credentials or sensitive personal data,” never interpolate it into logs before validation, and retain the shared CSV formula guard.              | Use a short reason code plus an optional local note omitted from machine output.                                                              |
| W5. Stale/unmatched state can be hidden by legacy output contracts            | Operators may believe a dispute is active while it is stale, unmatched, or not evaluated; automation may read the old proposal count and miss quarantine.                                                                                                                               | Bump the evaluation schema, emit full override rows in JSON/YAML/CSV, show stale/unmatched results without `--verbose`, include disposition in `--explain`, recompute rule/summary counts, and make `--fail-on proposals` fail on stale disputes.             | Add a separate stricter `--fail-on overrides` gate, but stale must still remain non-actionable in every mode.                                 |
| W6. Existing sealed artifacts are outside a config-only suppression snapshot  | Adding an override after a plan was sealed does not alter the checksum-pinned artifact; standalone apply cannot infer a decision key that the underlying producer artifact does not carry.                                                                                              | State the boundary explicitly: v1 governs new evaluations and same-run policy-plan/sync projection, not previously sealed artifacts. Document removal/quarantine of old artifacts when disputing a decision.                                                  | Bind decision keys and an override-snapshot digest into future artifact schemas and revalidate at apply time; this is larger than minimal v1. |

- W1/W2 — **Confidence**: High. RFC 8785 specifies invariant primitive serialization,
  recursive property sorting, preserved array order, UTF-8, and rejection of invalid JSON values.
- W3 — **Confidence**: High. `js-yaml` can produce own `__proto__` keys; MITRE CWE-1321 documents
  prototype modification risks through `__proto__`, `constructor`, and `prototype`.
- W4 — **Confidence**: High. The current presenters write report text directly to stderr, and the
  machine formats serialize it; OWASP recommends excluding sensitive data and sanitizing CR/LF and
  delimiters in event data.
- W5 — **Confidence**: High. The current v1 report has only proposals/skips and downstream reports
  embed it.
- W6 — **Confidence**: Medium. This follows the current producer/apply artifact boundary, but the
  product requirement could choose stronger retroactive revocation semantics.

### ADVISORY — Best Practices

| Finding                                              | Benefit                                                                                | Recommendation                                                                                                                                                        | Defer Justification                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A1. Config-file access is the authorization boundary | Makes it clear who can deny policy actions and protects private reasons.               | Keep overrides in the existing read-only `.rfmedia.yaml` path, add no writer command, recommend restrictive file permissions, and avoid committing sensitive reasons. | A dedicated `0600` store is unnecessary while v1 has no mutation or authoring command.                          |
| A2. A fingerprint is not authorization or secrecy    | Prevents treating a public deterministic digest as a signature or anonymization layer. | Label it a change detector; use unkeyed SHA-256 with domain separation. Do not add HMAC keys or expose a “verified author” claim.                                     | Signing is only useful if overrides later cross trust boundaries.                                               |
| A3. Override lifecycle hygiene                       | Reduces permanent fail-closed clutter and makes stale entries reviewable.              | Document replace/remove workflow and periodically surface unmatched/stale entries in automation.                                                                      | Automatic pruning should be deferred because it would mutate operator-authored state.                           |
| A4. No new dependency                                | Avoids supply-chain and maintenance cost.                                              | Reuse Node `node:crypto` and existing config parsing; implement only the small canonical projection required by this domain.                                          | A canonicalization package is justified later only if several independent signing/hash contracts need full JCS. |

- A1/A3 — **Confidence**: High. V1 is local config and existing commands already expose the needed
  read/evaluate path.
- A2/A4 — **Confidence**: High. NIST defines SHA-256 as a message-digest/change-detection primitive,
  and Node provides `createHash("sha256")` in the supported runtime.

## Authentication and Authorization

There is no new network endpoint, user session, token, or remote authorization decision. Authority
to suppress is the authority to edit the selected config file. That is acceptable because the same
editor can already disable rules or change thresholds; suppression only reduces the mutation set.

The existing mutation ladder remains authoritative:

1. evaluation gathers evidence and produces proposals;
2. the engine removes active/stale disputed proposals;
3. policy-plan or rating-sync projects only the remaining proposals;
4. producers seal artifacts using live Lidarr state;
5. apply retains explicit approval plus expected plan ID/checksum validation.

The override module must import no Plex/Lidarr client, producer, plan writer, apply action, or
credential provider. It must not be added to mutation-owner allowlists. A suppression entry alone
must perform zero filesystem writes and zero Plex/Lidarr mutations.

## Data Protection

Policy reports already reveal artist names, platform IDs, ratings/play evidence, server origins,
and desired Lidarr state. Override reasons may add operator-specific context. Treat all human and
machine reports as potentially sensitive operational artifacts; do not claim that hashing makes
the evidence anonymous.

Fingerprint material must exclude credentials, raw config, URLs with userinfo/query secrets,
`handoff.argv`, display names, free-form reason, summary/detail prose, and timestamps. Canonical
credential-free origins are safe to bind for scope. Add a sentinel-token regression test over
`JSON.stringify(report)` and every machine projection.

Do not persist a second copy in SQLite or a new store for v1. Retention, backup, review, and access
control remain those of `.rfmedia.yaml` and whatever captures command output.

## Dependency Security

| Dependency             | Version            | Known Issues                                                         | Risk Level | Alternative                                   |
| ---------------------- | ------------------ | -------------------------------------------------------------------- | ---------- | --------------------------------------------- |
| Node `node:crypto`     | Runtime `>=22.0.0` | Built-in API; no npm package added                                   | Low        | None needed                                   |
| `js-yaml`              | Installed `4.3.0`  | No advisory attributed to it by `npm audit --omit=dev` on 2026-08-06 | Low        | Keep existing parser and `CORE_SCHEMA`        |
| Canonical JSON package | None               | Adding one would create new supply-chain/version risk                | None       | Explicit bounded projection plus Node SHA-256 |

The workspace audit did report existing high-severity findings in `picomatch` and `ws`; neither is
introduced by or needed for this override path. Track them as repository dependency maintenance,
not as justification for adding another package here. **Confidence**: High — current lockfile and
audit inspected 2026-08-06.

## Input Validation

Validate before any gather or projection:

- `policy.overrides` is an ordinary/null-prototype object with at most 500 own entries.
- Each key is at most 256 UTF-8 bytes, control/bidi-free, and exactly matches a currently registered
  **proposal** key grammar. Mutation-bound artist IDs are canonical positive safe integers; Plex IDs
  are non-empty and bounded. Skip-code suffixes are not accepted.
- Each value is an ordinary/null-prototype object with exactly own keys `action`,
  `evidenceFingerprint`, and `reason`.
- `action` is exactly `suppress`; fingerprint is exactly `^sha256:[0-9a-f]{64}$`.
- Reason is trimmed, non-empty, bounded (500 Unicode scalar values and a byte ceiling), and rejects
  C0/C1 controls, DEL, and Unicode bidi controls.
- `__proto__`, `prototype`, and `constructor` are rejected wherever a map key is accepted. Build the
  validated lookup with `Map`, not assignment into `{}`; use `Object.hasOwn` rather than `in`.
- Never stringify arbitrary malformed values in an error. Report a stable property path and type.
- A canonicalization failure, duplicate/conflicting current key, or fingerprint failure blocks the
  run; it must never downgrade to “override did not match.”

## Infrastructure Security

No CORS, CSP, rate limiting, TLS, or network-service change is required. Existing Plex/Lidarr
credential resolution and cross-origin guards remain untouched. The relevant infrastructure
controls are local file ownership, strict precedence, bounded parsing, and stdout/stderr purity.

Strict loading must apply to all three consumers (`policy evaluate`, `policy plan`, and
`sync-ratings`) so they cannot disagree about which override file won. Cache one validated snapshot
for a command run. Mid-run edits take effect on the next invocation; document that snapshot model.

## Secure Coding Guidelines

- Keep fingerprinting and disposition pure, synchronous, deterministic, and deeply frozen.
- Domain-separate with a literal such as `rfmedia.lidarr-policy-evidence.v1` and include report scope.
- Include semantic facts: key/rule/code, subject IDs and MBID, identity basis, before/after, checks
  (including bound, observed, result, and config path), observations/provenance, and producer.
- Exclude display-only and volatile fields. A wording or timestamp edit must not rotate the digest;
  an identity, scope, threshold, evidence, current/desired state, or decision-code change must.
- Sort object keys by deterministic code-unit comparison, never locale; preserve semantically
  ordered arrays. Reject non-finite numbers and invalid Unicode rather than coercing them.
- Classify exact proposal+fingerprint as `suppressed`; key match with changed evidence or a current
  skip on the same subject anchor as `stale`; deselected/disabled rule as `not-evaluated`; completed
  rule with no anchor as `unmatched`.
- Active and stale records are non-actionable. Never synthesize a proposal from a skip and never
  refill a capped cohort after suppression.
- Keep full expected/current fingerprints in machine output and explain view; table abbreviation is
  presentation only.

## Critical Test Matrix

1. **Force refusal:** every action except literal `suppress`, every operator-supplied desired-state
   field, and every skip key fails validation before evaluation.
2. **Mutation bypass:** active and stale matches are absent from both `projectPolicyPlan()` and
   `buildRatingSyncPlan()` cohorts; in sync apply mode no producer, prompt, or apply dependency is
   called for a fully disputed cohort.
3. **Malformed config:** invalid YAML, duplicate YAML keys, bad fingerprint/action/reason, and
   unknown fields cause policy evaluate/plan/sync to exit rather than fall through to another file
   or empty config.
4. **Prototype objects:** own `__proto__`, `constructor`, and `prototype`; inherited fields;
   `Object.create(null)`; arrays/class instances; and hostile coercion objects yield bounded
   `ConfigError` values without pollution or unexpected throws.
5. **Golden fingerprint:** property insertion order and display/timestamp changes keep one fixed
   digest; origin/library, IDs/MBID, code, thresholds, ratings/plays/sample sizes, joins,
   before/after, and producer changes rotate it. Non-finite values and lone surrogates fail closed.
6. **Staleness taxonomy:** exact match, changed proposal, proposal-to-skip, deselected/disabled,
   missing subject, and ID reuse produce the documented statuses and precedence.
7. **Output contract:** stale/unmatched are visible without verbose; JSON/YAML/CSV carry full
   status and fingerprints; reason controls/bidi are rejected; CSV formula-looking reasons are
   neutralized; a sentinel credential never appears in any serialized report.
8. **Contract consistency:** summary/per-rule proposal counts equal the filtered actionable array,
   schema/version changes are asserted, reports remain deeply frozen, and `--fail-on proposals`
   fails for stale disputes.
9. **Boundary architecture:** evaluator/override modules have no plan writer, client mutation,
   adapter metadata, or apply imports; Bash/Zsh/Fish completion registries remain unchanged.
10. **Previously sealed artifact:** document and test that a later config edit does not silently
    rewrite an artifact; if revocation is implemented, apply must reject a mismatched override
    snapshot explicitly.

## Trade-off Recommendations

The safe minimal v1 is configuration-backed and suppression-only. It adds no store, writer,
signature, force action, command flag, or external dependency. Stale disputes quarantine only their
matching proposals while other independent proposals may proceed. This favors safety and clear
operator review at modest availability cost.

Strict config loading is the one cross-cutting cost that cannot be deferred. If changing global
loading is too disruptive, add a strict mode selected by policy and sync command paths or load the
override section independently and fatally. Do not compensate with warnings: warnings are not an
enforcement boundary for unattended apply.

## Open Questions

1. Should adding a dispute revoke previously sealed policy-derived artifacts, or is the documented
   “next evaluation only” boundary sufficient for v1?
2. Should stale disputes block only their matched proposals (recommended) or the entire apply run?
3. Should free-form reasons be emitted in all machine formats, or should v1 use a public reason code
   to reduce accidental PII/secret disclosure?
4. Is strict loading appropriate for every rfmedia command, or only the policy/plan/sync paths?

## Sources

- [GitHub issue #313](https://github.com/yandy-r/rfmedia-apps/issues/313) — created/updated
  2026-07-31; inspected 2026-08-06.
- [RFC 8785: JSON Canonicalization Scheme](https://datatracker.ietf.org/doc/html/rfc8785) — June
  2020; stable canonicalization specification.
- [NIST FIPS 180-4: Secure Hash Standard](https://csrc.nist.gov/pubs/fips/180-4/upd1/final) — August
  2015; stable SHA-2 specification (NIST notes a future revision).
- [Node.js `crypto.createHash`](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options)
  — current documentation accessed 2026-08-06.
- [YAML 1.2.2 specification](https://yaml.org/spec/1.2.2/) — 2021-10-01; mappings are unordered and
  keys are unique.
- [MITRE CWE-1321: Prototype Pollution](https://cwe.mitre.org/data/definitions/1321.html) — CWE 4.20
  page accessed 2026-08-06; content modified 2025-12-11.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
  — living guidance accessed 2026-08-06.

## Freshness Note

The external sources are stable specifications or living primary guidance. Dependency versions,
audit results, repository contracts, and issue state were inspected on 2026-08-06 and should be
rechecked if implementation begins from a later lockfile or policy schema.
