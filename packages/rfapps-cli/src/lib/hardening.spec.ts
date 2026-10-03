/**
 * Harden rule catalog and YAML patch engine tests.
 */

import { describe, expect, it } from "vitest";

import {
  applyHardenPatches,
  buildHardenOverride,
  detectReformat,
  evaluateHardening,
  HARDEN_RULES,
} from "./hardening.js";
import type {
  HardenComposeConfig,
  HardenComposeService,
  HardenPatch,
  HardenProposal,
} from "../types/hardening.js";

/**
 * Anchor-bearing source. `&logging-default` deliberately omits `max-size` so
 * harden-log-rotation fires on the alias and the alias guard is reachable; the
 * driver must stay rotation-capable or the rule downgrades itself to advisory
 * and proposes nothing.
 * NEVER assert against the repository's real compose.yml.
 */
const ANCHORED_COMPOSE = `x-service-base: &service-base
  restart: unless-stopped
  pull_policy: missing

x-logging-default: &logging-default
  driver: json-file

services:
  sonarr:
    <<: *service-base
    image: sonarr:latest
    logging: *logging-default
    cap_drop:
      - ALL
  plex:
    <<: *service-base
    image: plex:latest
    logging: *logging-default
    security_opt: "no-new-privileges:true"
`;

const ANCHOR_BLOCK = "x-logging-default: &logging-default\n  driver: json-file";

/** `&secopt` is a service key another service aliases wholesale. */
const ANCHORED_KEY_COMPOSE = `services:
  alpha:
    image: alpha:latest
    security_opt: &secopt
      - seccomp=unconfined
  beta:
    image: beta:latest
    security_opt: *secopt
`;

/** `&alpha-service` is a whole service map another service \`<<:\`-merges. */
const ANCHORED_MAP_COMPOSE = `services:
  alpha: &alpha-service
    image: alpha:latest
  beta:
    <<: *alpha-service
    image: beta:latest
`;

/** The sequence itself is local; only the item is an alias. */
const ALIAS_ITEM_COMPOSE = `x-seccomp: &sec seccomp=unconfined

services:
  alpha:
    image: alpha:latest
    security_opt:
      - *sec
`;

/** The resolved view Docker returns for ANCHORED_COMPOSE (anchors already merged). */
function resolvedConfig(): HardenComposeConfig {
  return {
    services: {
      sonarr: {
        image: "sonarr:latest",
        restart: "unless-stopped",
        logging: { driver: "json-file" },
        cap_drop: ["ALL"],
      },
      plex: {
        image: "plex:latest",
        restart: "unless-stopped",
        logging: { driver: "json-file" },
        security_opt: ["no-new-privileges:true"],
      },
    },
  };
}

function proposalsFor(service: string, ruleIds: readonly string[]): HardenProposal[] {
  const { proposals } = evaluateHardening(resolvedConfig(), [service], { suppressions: [] });
  return proposals.filter((proposal) => ruleIds.includes(proposal.ruleId));
}

function handBuilt(service: string, patches: readonly HardenPatch[]): HardenProposal {
  return {
    ruleId: "harden-no-new-privileges",
    service,
    category: "capabilities",
    severity: "info",
    confidence: "safe",
    title: "test",
    rationale: "test",
    guidance: "test",
    detects: {},
    evidence: [],
    patches,
  };
}

/** Merge a rule's own patches into a resolved-service fixture (merge-unique values are full unions). */
function applyPatchesToService(
  service: HardenComposeService,
  patches: readonly HardenPatch[],
): HardenComposeService {
  const next: Record<string, unknown> = { ...service };
  for (const patch of patches) {
    next[patch.key] = patch.value;
  }
  return next as unknown as HardenComposeService;
}

describe("applyHardenPatches", () => {
  it("refuses to write through a YAML alias and leaves the source untouched", () => {
    const result = applyHardenPatches(
      ANCHORED_COMPOSE,
      proposalsFor("sonarr", ["harden-log-rotation"]),
    );

    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({
      code: "alias-target",
      service: "sonarr",
      ruleId: "harden-log-rotation",
      // The anchor name is documented operator-facing output, not "(*anchor)".
      detail: expect.stringContaining("(*logging-default)"),
    });
    expect(result.patchesWritten).toBe(0);
    expect(result.content).toBe(ANCHORED_COMPOSE);
  });

  it("refuses to write a service key that carries an anchor another service aliases", () => {
    const proposal = handBuilt("alpha", [
      {
        key: "security_opt",
        operation: "merge-unique",
        value: ["seccomp=unconfined", "no-new-privileges:true"],
        description: 'security_opt += ["no-new-privileges:true"]',
      },
    ]);

    const result = applyHardenPatches(ANCHORED_KEY_COMPOSE, [proposal]);

    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({
      code: "alias-target",
      service: "alpha",
      detail: expect.stringContaining("&secopt"),
    });
    expect(result.patchesWritten).toBe(0);
    expect(result.content).toBe(ANCHORED_KEY_COMPOSE);
    expect(result.content).toContain("security_opt: &secopt\n      - seccomp=unconfined");
  });

  it("refuses to write into a service map another service merges, without throwing", () => {
    const proposal = handBuilt("alpha", [
      { key: "restart", operation: "set", value: "unless-stopped", description: "restart = set" },
    ]);

    // `set` on an anchored map would orphan *alpha-service and make
    // serializeComposeDocument throw out of the patch path.
    const result = applyHardenPatches(ANCHORED_MAP_COMPOSE, [proposal]);

    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({
      code: "alias-target",
      service: "alpha",
      detail: expect.stringContaining("&alpha-service"),
    });
    expect(result.patchesWritten).toBe(0);
    expect(result.content).toBe(ANCHORED_MAP_COMPOSE);
    expect(result.content).toContain("alpha: &alpha-service");
  });

  it("does not append the value an alias sequence item already resolves to", () => {
    const proposal = handBuilt("alpha", [
      {
        key: "security_opt",
        operation: "merge-unique",
        value: ["seccomp=unconfined", "no-new-privileges:true"],
        description: 'security_opt += ["no-new-privileges:true"]',
      },
    ]);

    const result = applyHardenPatches(ALIAS_ITEM_COMPOSE, [proposal]);

    expect(result.refusals).toEqual([]);
    expect(result.patchesWritten).toBe(1);
    expect(result.content).toContain("x-seccomp: &sec seccomp=unconfined");
    expect(result.content).toContain("- *sec");
    expect(result.content).not.toContain("- seccomp=unconfined");
    expect(result.content).toContain("- no-new-privileges:true");
  });

  it("creates a local key on a merge-keyed service without disturbing the anchor", () => {
    const result = applyHardenPatches(
      ANCHORED_COMPOSE,
      proposalsFor("sonarr", ["harden-no-new-privileges"]),
    );

    expect(result.refusals).toEqual([]);
    expect(result.patchesWritten).toBe(1);
    expect(result.servicesPatched).toEqual(["sonarr"]);
    expect(result.content).toContain("<<: *service-base");
    expect(result.content).toContain("- no-new-privileges:true");
    expect(result.content).toContain(ANCHOR_BLOCK);
  });

  it("does not duplicate an entry a merge-unique sequence already contains", () => {
    const proposal = handBuilt("sonarr", [
      {
        key: "cap_drop",
        operation: "merge-unique",
        value: ["ALL"],
        description: 'cap_drop += ["ALL"]',
      },
    ]);

    const result = applyHardenPatches(ANCHORED_COMPOSE, [proposal]);

    expect(result.refusals).toEqual([]);
    expect((result.content.match(/- ALL/g) ?? []).length).toBe(1);
  });

  it("refuses merge-unique when the existing node is not a sequence", () => {
    const proposal = handBuilt("plex", [
      {
        key: "security_opt",
        operation: "merge-unique",
        value: ["no-new-privileges:true", "seccomp=unconfined"],
        description: 'security_opt += ["seccomp=unconfined"]',
      },
    ]);

    const result = applyHardenPatches(ANCHORED_COMPOSE, [proposal]);

    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.code).toBe("unexpected-node");
    expect(result.patchesWritten).toBe(0);
    expect(result.content).toBe(ANCHORED_COMPOSE);
  });

  it("refuses a patch for a service the compose document does not declare", () => {
    const proposal = handBuilt("radarr", [
      { key: "read_only", operation: "set", value: true, description: "read_only = true" },
    ]);

    const result = applyHardenPatches(ANCHORED_COMPOSE, [proposal]);

    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.code).toBe("service-missing");
    expect(result.refusals[0]?.alternative).toContain("--out");
  });
});

describe("buildHardenOverride", () => {
  it("emits the full union of an existing sequence and the addition", () => {
    const config: HardenComposeConfig = {
      services: {
        sonarr: {
          image: "sonarr:latest",
          restart: "unless-stopped",
          logging: { driver: "journald", options: { "max-size": "10m" } },
          security_opt: ["seccomp=unconfined"],
        },
      },
    };
    const { proposals } = evaluateHardening(config, ["sonarr"], { suppressions: [] });
    const writable = proposals.filter((proposal) => proposal.ruleId === "harden-no-new-privileges");

    const override = buildHardenOverride(writable, {
      composePath: "/srv/apps/compose.yml",
      timestamp: "2026-07-30T00:00:00.000Z",
      includeReview: false,
    });

    expect(override.patchesWritten).toBe(1);
    expect(override.content).toContain("- seccomp=unconfined");
    expect(override.content).toContain("- no-new-privileges:true");
  });
});

describe("detectReformat", () => {
  it("reports a negative line delta when canonical serialization collapses a flow sequence", () => {
    const source =
      'services:\n  a:\n    healthcheck:\n      test:\n        [\n          "CMD",\n          "true",\n        ]\n';

    const reformat = detectReformat(source);

    expect(reformat.wouldReformat).toBe(true);
    expect(reformat.lineDelta).toBeLessThan(0);
  });

  it("reports no churn for already-canonical source", () => {
    expect(detectReformat("services:\n  a:\n    image: nginx\n")).toEqual({
      wouldReformat: false,
      lineDelta: 0,
    });
  });
});

describe("harden-log-rotation", () => {
  function rotationProposal(service: HardenComposeService): HardenProposal | undefined {
    const { proposals } = evaluateHardening({ services: { app: service } }, ["app"], {
      suppressions: [],
    });
    return proposals.find((proposal) => proposal.ruleId === "harden-log-rotation");
  }

  it("is advisory with no patches on a driver that has no max-size option", () => {
    const proposal = rotationProposal({
      image: "app:latest",
      logging: { driver: "syslog", options: { "syslog-address": "udp://logs.example:514" } },
    });

    expect(proposal?.confidence).toBe("advisory");
    expect(proposal?.patches).toEqual([]);
    expect(proposal?.note).toContain("syslog");
  });

  it("preserves the existing json-file options it did not target", () => {
    const proposal = rotationProposal({
      image: "app:latest",
      logging: { driver: "json-file", options: { tag: "app", "max-file": "9" } },
    });

    expect(proposal?.confidence).toBe("safe");
    expect(proposal?.patches).toEqual([
      {
        key: "logging",
        operation: "set",
        value: {
          driver: "json-file",
          options: { tag: "app", "max-file": "9", "max-size": "10m" },
        },
        description:
          'logging = { driver: "json-file", options: { tag: "app", max-file: "9", max-size: "10m" } }',
      },
    ]);
  });
});

describe("HARDEN_RULES", () => {
  it.each(HARDEN_RULES.map((rule) => [rule.id, rule] as const))(
    "%s declares single-segment patch keys and array values for merge-unique",
    (_id, rule) => {
      for (const patch of rule.propose({})) {
        expect(patch.key).not.toContain(".");
        expect(patch.key).not.toContain("/");
        if (patch.operation === "merge-unique") {
          expect(Array.isArray(patch.value)).toBe(true);
        }
      }
    },
  );

  // Idempotence is why merge-unique exists: `rfapps harden --apply` twice must be a
  // no-op. Advisory rules are excluded by construction — they propose nothing, so
  // detect keeps firing and the assertion would be unsatisfiable.
  it.each(
    HARDEN_RULES.filter((rule) => rule.confidence !== "advisory").map(
      (rule) => [rule.id, rule] as const,
    ),
  )("%s is idempotent: re-detecting after its own proposal returns undefined", (_id, rule) => {
    const before: HardenComposeService = {};
    expect(rule.detect(before, "app")).toBeDefined();
    const after = applyPatchesToService(before, rule.propose(before));
    expect(rule.detect(after, "app")).toBeUndefined();
  });
});
