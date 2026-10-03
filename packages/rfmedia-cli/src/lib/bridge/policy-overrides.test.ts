import { describe, expect, it } from "vitest";

import type { PolicyOverrideConfigOptions } from "../../types/config.js";
import type {
  PolicyDecisionEvidenceFingerprint,
  PolicyObservation,
  PolicyProposal,
  PolicyRuleId,
  PolicyRuleResult,
  PolicySkip,
  PolicyThresholdCheck,
} from "../../types/lidarr-policy.js";
import {
  fingerprintPolicyProposal,
  reconcilePolicyOverrides,
  type PolicyDecisionEvidenceScope,
} from "./policy-overrides.js";

const SCOPE: PolicyDecisionEvidenceScope = Object.freeze({
  plexOrigin: "https://plex.example.test",
  lidarrOrigin: "https://lidarr.example.test",
  plexLibrary: "Music",
});

const CHECKS: readonly PolicyThresholdCheck[] = Object.freeze([
  Object.freeze({
    signal: "plexArtistRatings",
    label: "artist rating",
    comparator: ">=" as const,
    bound: 4,
    observed: 4.5,
    satisfied: true,
    configPath: "policy.rules.rating-quality-upgrade.minRating",
  }),
  Object.freeze({
    signal: "derived",
    label: "profile differs",
    comparator: "!=" as const,
    bound: 6,
    observed: 2,
    satisfied: true,
    configPath: null,
  }),
]);

const OBSERVATIONS: Readonly<Record<string, PolicyObservation<number | boolean>>> = Object.freeze({
  rating: Object.freeze({
    status: "observed",
    value: 4.5,
    join: "exact-plex-id",
    sampleSize: 1,
  }),
  plays: Object.freeze({
    status: "observed",
    value: 8,
    join: "normalized-name",
    sampleSize: 3,
  }),
});

function proposal(overrides: Partial<PolicyProposal> = {}): PolicyProposal {
  return Object.freeze({
    key: "rating-quality-upgrade:artist:41",
    ruleId: "rating-quality-upgrade",
    code: "rating-below-target-profile",
    subject: Object.freeze({
      kind: "artist",
      name: "Example Artist",
      plexId: "plex-41",
      artistId: 41,
      artistMbid: "11111111-1111-1111-1111-111111111111",
    }),
    identity: Object.freeze({ category: "authoritative", reason: "unique-exact-mbid" }),
    before: Object.freeze({ monitored: true, qualityProfileId: 2 }),
    after: Object.freeze({ monitored: true, qualityProfileId: 6 }),
    checks: CHECKS,
    observations: OBSERVATIONS,
    summary: "Assign the target quality profile",
    handoff: Object.freeze({
      producer: "artist-profile-assignment",
      argv: Object.freeze(["lidarr", "plan", "artist-profiles", "--artist-id", "41"]),
    }),
    ...overrides,
  });
}

const LAST_VIEWED_AT = 1_767_225_600;
const LAST_VIEWED_AT_ISO = "2026-01-01T00:00:00.000Z";

function recencyProposal(
  options: {
    readonly lastViewedAt?: number;
    readonly minDaysSinceLastViewed?: number;
  } = {},
): PolicyProposal {
  const lastViewedAt = options.lastViewedAt ?? LAST_VIEWED_AT;
  const minDaysSinceLastViewed = options.minDaysSinceLastViewed ?? 90;

  return proposal({
    key: "stale-monitoring-cleanup:artist:41",
    ruleId: "stale-monitoring-cleanup",
    code: "monitored-artist-unconsumed",
    before: Object.freeze({ monitored: true }),
    after: Object.freeze({ monitored: false }),
    checks: Object.freeze([
      Object.freeze({
        signal: "plexTrackPlays",
        label: "days since last view",
        comparator: "older-than-days",
        bound: minDaysSinceLastViewed,
        observed:
          lastViewedAt === LAST_VIEWED_AT
            ? LAST_VIEWED_AT_ISO
            : new Date(lastViewedAt * 1_000).toISOString(),
        satisfied: true,
        configPath: "policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed",
      }),
    ]),
    observations: Object.freeze({
      lastViewedAt: Object.freeze({
        status: "observed",
        value: lastViewedAt,
        join: "normalized-name",
        sampleSize: 3,
      }),
    }),
    handoff: Object.freeze({
      producer: "artist-monitoring",
      argv: Object.freeze(["lidarr", "plan", "artist-monitoring", "--ids", "41", "--unmonitored"]),
    }),
  });
}

function skipFor(candidate: PolicyProposal): PolicySkip {
  return Object.freeze({
    key: `${candidate.key}:already-converged`,
    ruleId: candidate.ruleId,
    code: "already-converged",
    subject: candidate.subject,
    identity: candidate.identity,
    checks: candidate.checks,
    detail: "The current state already matches",
  });
}

function ranRule(id: PolicyRuleId, proposedCount = 0): PolicyRuleResult {
  return proposedCount === 0
    ? Object.freeze({ id, title: id, status: "clean", proposedCount: 0, skippedCount: 0 })
    : Object.freeze({ id, title: id, status: "proposals", proposedCount, skippedCount: 0 });
}

function skippedRule(id: PolicyRuleId): PolicyRuleResult {
  return Object.freeze({
    id,
    title: id,
    status: "skipped",
    skipReason: "not-selected",
    detail: "not selected",
  });
}

function configured(
  evidenceFingerprint: PolicyDecisionEvidenceFingerprint,
  reason = "Reviewed with the library owner",
): PolicyOverrideConfigOptions {
  return Object.freeze({ action: "suppress", evidenceFingerprint, reason });
}

function fakeFingerprint(character: string): PolicyDecisionEvidenceFingerprint {
  return `sha256:${character.repeat(64)}` as PolicyDecisionEvidenceFingerprint;
}

function unsafeFixture<T>(value: unknown): T {
  return value as T;
}

function unsafeObservation(value: unknown): PolicyObservation<number | boolean> {
  return unsafeFixture(value);
}

describe("fingerprintPolicyProposal", () => {
  it("pins the explicit v1 evidence tuple to one golden SHA-256 value", () => {
    expect(fingerprintPolicyProposal(proposal(), SCOPE)).toBe(
      "sha256:de2a3572c677a0d7b4497d48d4818ca8485aa5a316ac865bc56acde34db61ba2",
    );
  });

  it("ignores display prose, argv, and unordered record insertion", () => {
    const reordered = proposal({
      subject: Object.freeze({ ...proposal().subject, name: "Renamed Artist" }),
      summary: "Different display-only prose",
      before: Object.freeze({ qualityProfileId: 2, monitored: true }),
      after: Object.freeze({ qualityProfileId: 6, monitored: true }),
      checks: Object.freeze(
        CHECKS.map((check) => Object.freeze({ ...check, label: `renamed ${check.label}` })),
      ),
      observations: Object.freeze({
        plays: OBSERVATIONS["plays"]!,
        rating: OBSERVATIONS["rating"]!,
      }),
      handoff: Object.freeze({
        producer: "artist-profile-assignment",
        argv: Object.freeze(["this", "is", "display-only"]),
      }),
    });

    expect(fingerprintPolicyProposal(reordered, SCOPE)).toBe(
      fingerprintPolicyProposal(proposal(), SCOPE),
    );
  });

  it("accepts and deterministically canonicalizes stable recency evidence", () => {
    const candidate = recencyProposal();
    const fingerprint = fingerprintPolicyProposal(candidate, SCOPE);

    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(fingerprintPolicyProposal(candidate, SCOPE)).toBe(fingerprint);
  });

  it.each([
    ["raw timestamp", { lastViewedAt: LAST_VIEWED_AT + 1 }],
    ["configured day threshold", { minDaysSinceLastViewed: 91 }],
  ] as const)("rotates recency evidence when the %s changes", (_label, options) => {
    expect(fingerprintPolicyProposal(recencyProposal(options), SCOPE)).not.toBe(
      fingerprintPolicyProposal(recencyProposal(), SCOPE),
    );
  });

  it.each(["no-recency-coverage", "partial-recency-coverage"] as const)(
    "accepts the %s observation gap",
    (reason) => {
      const candidate = proposal({
        observations: Object.freeze({
          lastViewedAt: Object.freeze({ status: "unavailable", reason }),
        }),
      });

      expect(() => fingerprintPolicyProposal(candidate, SCOPE)).not.toThrow();
    },
  );

  it.each([
    ["Plex origin", proposal(), { ...SCOPE, plexOrigin: "https://other-plex.test" }],
    ["Lidarr origin", proposal(), { ...SCOPE, lidarrOrigin: "https://other-lidarr.test" }],
    ["library", proposal(), { ...SCOPE, plexLibrary: "Other Music" }],
    ["key", proposal({ key: "rating-quality-upgrade:artist:42" }), SCOPE],
    ["rule", proposal({ ruleId: "stale-monitoring-cleanup" }), SCOPE],
    ["code", proposal({ code: "monitored-artist-unconsumed" }), SCOPE],
    [
      "Plex id",
      proposal({ subject: Object.freeze({ ...proposal().subject, plexId: "plex-99" }) }),
      SCOPE,
    ],
    [
      "Lidarr id",
      proposal({ subject: Object.freeze({ ...proposal().subject, artistId: 99 }) }),
      SCOPE,
    ],
    [
      "artist MBID",
      proposal({ subject: Object.freeze({ ...proposal().subject, artistMbid: null }) }),
      SCOPE,
    ],
    [
      "identity",
      proposal({
        identity: Object.freeze({
          category: "review-normalized-name",
          reason: "unique-normalized-name",
        }),
      }),
      SCOPE,
    ],
    ["before state", proposal({ before: Object.freeze({ qualityProfileId: 3 }) }), SCOPE],
    ["after state", proposal({ after: Object.freeze({ qualityProfileId: 7 }) }), SCOPE],
    [
      "check signal",
      proposal({
        checks: Object.freeze([
          Object.freeze({ ...CHECKS[0]!, signal: "plexTrackPlays" as const }),
          CHECKS[1]!,
        ]),
      }),
      SCOPE,
    ],
    [
      "check comparator",
      proposal({
        checks: Object.freeze([
          Object.freeze({ ...CHECKS[0]!, comparator: "<=" as const }),
          CHECKS[1]!,
        ]),
      }),
      SCOPE,
    ],
    [
      "check bound",
      proposal({
        checks: Object.freeze([Object.freeze({ ...CHECKS[0]!, bound: 5 }), CHECKS[1]!]),
      }),
      SCOPE,
    ],
    [
      "check observed",
      proposal({
        checks: Object.freeze([Object.freeze({ ...CHECKS[0]!, observed: 5 }), CHECKS[1]!]),
      }),
      SCOPE,
    ],
    [
      "check satisfaction",
      proposal({
        checks: Object.freeze([Object.freeze({ ...CHECKS[0]!, satisfied: false }), CHECKS[1]!]),
      }),
      SCOPE,
    ],
    [
      "check config path",
      proposal({
        checks: Object.freeze([Object.freeze({ ...CHECKS[0]!, configPath: null }), CHECKS[1]!]),
      }),
      SCOPE,
    ],
    ["check order", proposal({ checks: Object.freeze([CHECKS[1]!, CHECKS[0]!]) }), SCOPE],
    [
      "observation value",
      proposal({
        observations: Object.freeze({
          ...OBSERVATIONS,
          plays: Object.freeze({ ...OBSERVATIONS["plays"]!, value: 9 }),
        }),
      }),
      SCOPE,
    ],
    [
      "observation provenance",
      proposal({
        observations: Object.freeze({
          ...OBSERVATIONS,
          plays: Object.freeze({ ...OBSERVATIONS["plays"]!, join: "exact-plex-id" }),
        }),
      }),
      SCOPE,
    ],
    [
      "observation sample size",
      proposal({
        observations: Object.freeze({
          ...OBSERVATIONS,
          plays: Object.freeze({ ...OBSERVATIONS["plays"]!, sampleSize: 4 }),
        }),
      }),
      SCOPE,
    ],
    [
      "observation status",
      proposal({
        observations: Object.freeze({
          ...OBSERVATIONS,
          plays: Object.freeze({
            status: "unavailable" as const,
            reason: "no-track-coverage" as const,
          }),
        }),
      }),
      SCOPE,
    ],
    [
      "producer",
      proposal({
        handoff: Object.freeze({ producer: "artist-monitoring", argv: Object.freeze([]) }),
      }),
      SCOPE,
    ],
  ] as const)("rotates when %s changes", (_label, candidate, scope) => {
    expect(fingerprintPolicyProposal(candidate, scope)).not.toBe(
      fingerprintPolicyProposal(proposal(), SCOPE),
    );
  });

  it("rotates when an unavailable observation reason changes", () => {
    const unavailable = (reason: "no-track-coverage" | "no-plex-artist") =>
      proposal({
        observations: Object.freeze({
          ...OBSERVATIONS,
          plays: Object.freeze({ status: "unavailable" as const, reason }),
        }),
      });

    expect(fingerprintPolicyProposal(unavailable("no-track-coverage"), SCOPE)).not.toBe(
      fingerprintPolicyProposal(unavailable("no-plex-artist"), SCOPE),
    );
  });

  it("rejects non-finite state and observation evidence", () => {
    expect(() =>
      fingerprintPolicyProposal(proposal({ before: Object.freeze({ rating: Number.NaN }) }), SCOPE),
    ).toThrow(/finite JSON scalar/);
    expect(() =>
      fingerprintPolicyProposal(
        proposal({
          observations: Object.freeze({
            plays: Object.freeze({
              status: "observed",
              value: 8,
              join: "normalized-name",
              sampleSize: Number.POSITIVE_INFINITY,
            }),
          }),
        }),
        SCOPE,
      ),
    ).toThrow(/finite JSON scalar/);
  });

  it.each([
    [
      "undefined subject kind",
      "subject.kind",
      proposal({
        subject: unsafeFixture({ ...proposal().subject, kind: undefined }),
      }),
    ],
    [
      "malformed subject kind",
      "subject.kind",
      proposal({
        subject: unsafeFixture({ ...proposal().subject, kind: "album" }),
      }),
    ],
    [
      "undefined unavailable reason",
      "observations.rating.reason",
      proposal({
        observations: Object.freeze({
          rating: unsafeObservation({ status: "unavailable", reason: undefined }),
        }),
      }),
    ],
    [
      "malformed unavailable reason",
      "observations.rating.reason",
      proposal({
        observations: Object.freeze({
          rating: unsafeObservation({ status: "unavailable", reason: "unknown-gap" }),
        }),
      }),
    ],
    [
      "undefined observed join",
      "observations.rating.join",
      proposal({
        observations: Object.freeze({
          rating: unsafeObservation({ status: "observed", value: 4.5, join: undefined }),
        }),
      }),
    ],
    [
      "malformed observed join",
      "observations.rating.join",
      proposal({
        observations: Object.freeze({
          rating: unsafeObservation({ status: "observed", value: 4.5, join: "database-row" }),
        }),
      }),
    ],
  ] as const)("rejects %s instead of collapsing it to null", (_label, path, candidate) => {
    expect(() => fingerprintPolicyProposal(candidate, SCOPE)).toThrow(path);
  });

  it.each([
    ["rule id", "ruleId", proposal({ ruleId: unsafeFixture("unknown-rule") })],
    ["decision code", "code", proposal({ code: unsafeFixture("unknown-decision") })],
    [
      "identity category",
      "identity.category",
      proposal({
        identity: unsafeFixture({ ...proposal().identity, category: "review" }),
      }),
    ],
    [
      "identity reason",
      "identity.reason",
      proposal({
        identity: unsafeFixture({ ...proposal().identity, reason: "unknown-reason" }),
      }),
    ],
    [
      "check signal",
      "checks.0.signal",
      proposal({
        checks: [unsafeFixture({ ...CHECKS[0]!, signal: "unknown-signal" })],
      }),
    ],
    [
      "check comparator",
      "checks.0.comparator",
      proposal({
        checks: [unsafeFixture({ ...CHECKS[0]!, comparator: ">" })],
      }),
    ],
    [
      "observation status",
      "observations.rating.status",
      proposal({
        observations: { rating: unsafeObservation({ status: "missing", reason: "unrated" }) },
      }),
    ],
    [
      "handoff producer",
      "handoff.producer",
      proposal({
        handoff: unsafeFixture({ ...proposal().handoff, producer: "direct-apply" }),
      }),
    ],
  ] as const)("rejects a malformed %s enum", (_label, path, candidate) => {
    expect(() => fingerprintPolicyProposal(candidate, SCOPE)).toThrow(path);
  });
});

describe("reconcilePolicyOverrides", () => {
  it("stamps every proposal and leaves an unconfigured cohort actionable", () => {
    const first = proposal();
    const result = reconcilePolicyOverrides({
      ...SCOPE,
      proposals: [first],
      skips: [],
      rules: [ranRule(first.ruleId, 1)],
      overrides: undefined,
    });

    expect(result.proposals).toEqual([
      expect.objectContaining({
        key: first.key,
        evidenceFingerprint: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(result.overrides).toEqual([]);
    expect(first).not.toHaveProperty("evidenceFingerprint");
  });

  it("suppresses an exact match, preserves review evidence, and never refills the cap", () => {
    const first = proposal();
    const fingerprint = fingerprintPolicyProposal(first, SCOPE);
    const result = reconcilePolicyOverrides({
      ...SCOPE,
      proposals: [first],
      skips: [],
      rules: [ranRule(first.ruleId, 1)],
      overrides: { [first.key]: configured(fingerprint) },
    });

    expect(result.proposals).toEqual([]);
    expect(result.overrides).toEqual([
      expect.objectContaining({
        key: first.key,
        status: "suppressed",
        staleReason: null,
        expectedEvidenceFingerprint: fingerprint,
        currentEvidenceFingerprint: fingerprint,
        decision: expect.objectContaining({ key: first.key, evidenceFingerprint: fingerprint }),
      }),
    ]);
  });

  it("quarantines changed evidence while preserving unrelated proposals", () => {
    const disputed = proposal();
    const unrelated = proposal({
      key: "rating-quality-upgrade:artist:88",
      subject: Object.freeze({ ...proposal().subject, artistId: 88, plexId: "plex-88" }),
    });
    const result = reconcilePolicyOverrides({
      ...SCOPE,
      proposals: [unrelated, disputed],
      skips: [],
      rules: [ranRule(disputed.ruleId, 2)],
      overrides: { [disputed.key]: configured(fakeFingerprint("0")) },
    });

    expect(result.proposals.map((candidate) => candidate.key)).toEqual([unrelated.key]);
    expect(result.overrides[0]).toMatchObject({
      status: "stale",
      staleReason: "evidence-changed",
      decision: { key: disputed.key },
    });
  });

  it("classifies a current skip as outcome-changed without hiding the real skip", () => {
    const former = proposal();
    const currentSkip = skipFor(former);
    const result = reconcilePolicyOverrides({
      ...SCOPE,
      proposals: [],
      skips: [currentSkip],
      rules: [ranRule(former.ruleId)],
      overrides: { [former.key]: configured(fakeFingerprint("1")) },
    });

    expect(result.overrides[0]).toMatchObject({
      status: "stale",
      staleReason: "outcome-changed",
      currentEvidenceFingerprint: null,
      decision: currentSkip,
    });
    expect(currentSkip).toHaveProperty("code", "already-converged");
  });

  it.each([
    proposal({
      key: "stale-monitoring-cleanup:artist:41",
      ruleId: "stale-monitoring-cleanup",
    }),
    proposal({
      key: "discovery-seed:plex:plex-404",
      ruleId: "discovery-seed",
      subject: Object.freeze({
        kind: "artist",
        name: "Plex-only Artist",
        plexId: "plex-404",
        artistMbid: null,
      }),
    }),
  ])("matches the $ruleId universal identity refusal independently of reporting rule", (former) => {
    const subjectAnchor =
      former.subject.artistId === undefined
        ? `plex:${former.subject.plexId}`
        : `artist:${former.subject.artistId}`;
    const currentRefusal: PolicySkip = Object.freeze({
      key: `rating-quality-upgrade:${subjectAnchor}:identity-not-authoritative`,
      ruleId: "rating-quality-upgrade",
      code: "identity-not-authoritative",
      subject: former.subject,
      identity: Object.freeze({
        category: "unmatched",
        reason: "no-authoritative-source-match",
      }),
      checks: Object.freeze([]),
      detail: "The subject no longer has an authoritative identity",
    });
    const result = reconcilePolicyOverrides({
      ...SCOPE,
      proposals: [],
      skips: [currentRefusal],
      rules: [ranRule("rating-quality-upgrade"), ranRule(former.ruleId)],
      overrides: { [former.key]: configured(fakeFingerprint("1")) },
    });

    expect(result.overrides[0]).toMatchObject({
      status: "stale",
      staleReason: "outcome-changed",
      currentEvidenceFingerprint: null,
      decision: currentRefusal,
    });
  });

  it("distinguishes completed-rule absence from a rule that did not run", () => {
    const former = proposal();
    const absent = reconcilePolicyOverrides({
      ...SCOPE,
      proposals: [],
      skips: [],
      rules: [ranRule(former.ruleId)],
      overrides: { [former.key]: configured(fakeFingerprint("2")) },
    });
    const notEvaluated = reconcilePolicyOverrides({
      ...SCOPE,
      proposals: [],
      skips: [skipFor(former)],
      rules: [skippedRule(former.ruleId)],
      overrides: { [former.key]: configured(fakeFingerprint("2")) },
    });

    expect(absent.overrides[0]).toMatchObject({
      status: "stale",
      staleReason: "decision-absent",
      decision: null,
    });
    expect(notEvaluated.overrides[0]).toMatchObject({
      status: "not-evaluated",
      staleReason: null,
      decision: null,
    });
  });

  it("orders configured results by code unit and freezes every new result surface", () => {
    const first = proposal();
    const second = proposal({
      key: "rating-quality-upgrade:artist:8",
      subject: Object.freeze({ ...proposal().subject, artistId: 8, plexId: "plex-8" }),
    });
    const result = reconcilePolicyOverrides({
      ...SCOPE,
      proposals: [first, second],
      skips: [],
      rules: [ranRule(first.ruleId, 2)],
      overrides: {
        [second.key]: configured(fakeFingerprint("3")),
        [first.key]: configured(fakeFingerprint("4")),
      },
    });

    expect(result.overrides.map((entry) => entry.key)).toEqual([first.key, second.key]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.proposals)).toBe(true);
    expect(Object.isFrozen(result.overrides)).toBe(true);
    expect(Object.isFrozen(result.overrides[0])).toBe(true);
    expect(Object.isFrozen(result.overrides[0]?.decision)).toBe(true);
  });
});
