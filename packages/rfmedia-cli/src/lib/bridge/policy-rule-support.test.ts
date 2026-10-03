/**
 * The two `policy-rule-support.ts` invariants that library DATA can trip
 * (issue #209, design §7.1 item 5, §4 key format).
 *
 * Both are about the boundary between argv structure and operator strings: a
 * handoff must refuse `apply` in a verb position while accepting an artist
 * literally titled "apply", and a skip key must stay total when one subject
 * draws two refusals from one rule.
 */

import { describe, expect, it } from "vitest";

import type { PolicySubject, PolicyThresholdCheck } from "../../types/lidarr-policy.js";
import {
  buildPolicyHandoff,
  createPolicySeedProposal,
  createPolicySkip,
} from "./policy-rule-support.js";

const SEED_SUBJECT: PolicySubject = {
  kind: "artist",
  name: "apply",
  plexId: "p1",
  artistMbid: null,
};

const RATING_CHECK: PolicyThresholdCheck = {
  signal: "plexArtistRatings",
  label: "Plex artist rating >= 5 stars",
  comparator: ">=",
  bound: 5,
  observed: 5,
  satisfied: true,
  configPath: "policy.rules.discovery-seed.minRating",
};

describe("buildPolicyHandoff — the forbidden-token guard polices verbs, not data", () => {
  it("still throws when a verb position names apply", () => {
    expect(() => buildPolicyHandoff("artist-profile-assignment", ["lidarr", "apply"])).toThrow(
      /never contain "apply"/u,
    );
  });

  it("still throws when the vector names --plan-file, even as an option value", () => {
    expect(() =>
      buildPolicyHandoff("artist-profile-assignment", ["lidarr", "plan", "--out", "--plan-file"]),
    ).toThrow(/never contain "--plan-file"/u);
  });

  it("accepts a quality profile literally named apply", () => {
    const handoff = buildPolicyHandoff("artist-profile-assignment", [
      "lidarr",
      "plan",
      "artist-profiles",
      "--ids",
      "41",
      "--quality-profile",
      "apply",
    ]);

    expect(handoff.argv.at(-1)).toBe("apply");
  });

  it("seeds a Plex artist literally titled apply instead of failing the whole rule", () => {
    const proposal = createPolicySeedProposal({
      subject: SEED_SUBJECT,
      identity: { category: "unmatched", reason: "no-candidate" },
      checks: [RATING_CHECK],
      observations: { rating: { status: "observed", value: 5, join: "exact-plex-id" } },
      summary: "Rated 5 stars in Plex with no Lidarr candidate at all.",
      seedArtistName: "apply",
    });

    expect(proposal.key).toBe("discovery-seed:plex:p1");
    expect(proposal.handoff.argv).toEqual(["lidarr", "discover", "--artist", "apply"]);
  });
});

describe("createPolicySkip — the key carries the skip code", () => {
  it("distinguishes two refusals a single rule made about one subject", () => {
    const subject: PolicySubject = {
      kind: "artist",
      name: "Ghost Artist",
      plexId: "",
      artistId: 999,
      artistMbid: null,
    };
    const identity = { category: "unmatched", reason: "no-authoritative-source-match" } as const;

    const coverage = createPolicySkip({
      ruleId: "stale-monitoring-cleanup",
      code: "no-consumption-coverage",
      subject,
      identity,
      detail: "no authoritative Plex source",
    });
    const refusal = createPolicySkip({
      ruleId: "stale-monitoring-cleanup",
      code: "identity-not-authoritative",
      subject,
      identity,
      detail: "the bridge could not prove this identity",
    });

    expect(coverage.key).toBe("stale-monitoring-cleanup:artist:999:no-consumption-coverage");
    expect(refusal.key).toBe("stale-monitoring-cleanup:artist:999:identity-not-authoritative");
  });

  it("keys a Plex-only subject on the rating key and the code", () => {
    const skip = createPolicySkip({
      ruleId: "discovery-seed",
      code: "signal-unavailable",
      subject: { kind: "artist", name: "Seedling", plexId: "60", artistMbid: null },
      identity: { category: "unmatched", reason: "no-candidate" },
      detail: "unrated",
    });

    expect(skip.key).toBe("discovery-seed:plex:60:signal-unavailable");
  });
});
