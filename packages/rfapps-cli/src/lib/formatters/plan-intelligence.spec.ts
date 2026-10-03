import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  ChangeReason,
  ServiceImpact,
  ServiceIntelligence,
} from "../../types/plan-intelligence.js";

import { formatServiceIntelligenceLines } from "./plan-intelligence.js";

// Identity-function colors keep output assertions free of ANSI escapes
// (same approach as diff-helpers.spec.ts).
vi.mock("@rfmedia/common", () => ({
  colors: {
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    gray: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  },
}));

function makeReason(overrides: Partial<ChangeReason> = {}): ChangeReason {
  return {
    code: "image-reference-changed",
    kind: "trigger",
    confidence: "confirmed",
    decisive: true,
    summary: "image reference changed",
    evidence: [],
    ...overrides,
  };
}

function makeImpact(overrides: Partial<ServiceImpact> = {}): ServiceImpact {
  return {
    effect: "replace",
    critical: false,
    dependentCount: 0,
    dependents: [],
    dependentsTruncated: false,
    runningDependentCount: 0,
    changingDependencies: [],
    ...overrides,
  };
}

function makeIntelligence(overrides: Partial<ServiceIntelligence> = {}): ServiceIntelligence {
  return {
    reasons: [makeReason()],
    impact: makeImpact(),
    ...overrides,
  };
}

/** Return the single `why:` line, throwing when the renderer emitted none. */
function whyLine(lines: readonly string[]): string {
  const line = lines.find((candidate) => candidate.startsWith("why:"));
  if (line === undefined) {
    throw new Error(`no "why:" line rendered in: ${JSON.stringify(lines)}`);
  }
  return line;
}

describe("formatServiceIntelligenceLines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omits the impact line entirely when the service has no declared dependents", () => {
    const intelligence = makeIntelligence({
      impact: makeImpact({ dependentCount: 0, dependents: [], runningDependentCount: 0 }),
    });

    for (const verbose of [false, true]) {
      const lines = formatServiceIntelligenceLines(intelligence, { verbose });
      const rendered = lines.join("\n");

      expect(rendered).toContain("why:");
      expect(rendered).not.toContain("impact:");
      expect(rendered).not.toMatch(/dependent/i);
    }

    // A service that does have dependents still gets the line.
    const withDependents = formatServiceIntelligenceLines(
      makeIntelligence({
        impact: makeImpact({
          dependentCount: 4,
          dependents: ["kometa", "plexseerr", "requestrr", "tautulli"],
          runningDependentCount: 3,
        }),
      }),
      { verbose: false },
    );
    expect(withDependents.join("\n")).toContain(
      "impact: replaces the running container; 4 services declare depends_on this service (3 running)",
    );
  });

  it("suffixes the concise why line with [inferred] only when the lead reason is inferred", () => {
    const inferredLead = makeReason({
      code: "resolved-config-changed",
      kind: "provenance",
      confidence: "inferred",
      decisive: false,
      summary: "resolved config changed with the compose file unchanged",
    });

    const inferred = formatServiceIntelligenceLines(
      makeIntelligence({ reasons: [inferredLead, makeReason()] }),
      { verbose: false },
    );
    expect(whyLine(inferred)).toBe(
      "why: resolved config changed with the compose file unchanged; image differs [inferred]",
    );

    const confirmed = formatServiceIntelligenceLines(
      makeIntelligence({
        reasons: [{ ...inferredLead, confidence: "confirmed" }, makeReason()],
      }),
      { verbose: false },
    );
    expect(whyLine(confirmed)).not.toContain("[inferred]");
  });
});
