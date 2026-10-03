/**
 * Production-readiness lint engine tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { InvalidArgumentError } from "./errors.js";
import { buildContextNote, classifyFindingGroup, hasWritableBindMounts } from "./lint-context.js";
import { evaluateLint, LINT_RULES } from "./lint.js";
import type { LintComposeConfig, LintComposeService, LintRuleId } from "../types/lint.js";

/** Service that satisfies all production-readiness lint rules */
function compliantService(): LintComposeService {
  return {
    restart: "unless-stopped",
    healthcheck: { test: ["CMD", "true"] },
    logging: { options: { "max-size": "10m" } },
    deploy: { resources: { limits: { memory: "512M" } } },
    security_opt: ["no-new-privileges:true"],
    cap_drop: ["ALL"],
    read_only: true,
  };
}

function composeConfig(services: Record<string, LintComposeService>): LintComposeConfig {
  return { services };
}

function findingRuleIds(result: ReturnType<typeof evaluateLint>, service: string): LintRuleId[] {
  return result.findings
    .filter((finding) => finding.service === service)
    .map((finding) => finding.ruleId);
}

describe("evaluateLint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rule catalog", () => {
    it("defines exactly 8 production-readiness rules", () => {
      expect(LINT_RULES).toHaveLength(8);
    });
  });

  describe("rule severity defaults", () => {
    it.each(LINT_RULES.map((rule) => [rule.id, rule.severity] as const))(
      "assigns %s severity %s when the rule fires",
      (ruleId, expectedSeverity) => {
        const service = compliantService();

        switch (ruleId) {
          case "privileged-enabled":
            service.privileged = true;
            break;
          case "restart-policy-missing":
            delete service.restart;
            delete service.deploy?.restart_policy;
            break;
          case "healthcheck-missing":
            delete service.healthcheck;
            break;
          case "log-rotation-missing":
            delete service.logging;
            break;
          case "resource-limits-missing":
            delete service.deploy?.resources?.limits?.memory;
            if (service.deploy?.resources?.limits) {
              delete service.deploy.resources.limits.memory;
            }
            service.deploy = { ...service.deploy, resources: { limits: {} } };
            break;
          case "no-new-privileges-missing":
            service.security_opt = [];
            break;
          case "cap-drop-missing":
            delete service.cap_drop;
            break;
          case "read-only-rootfs":
            service.read_only = false;
            break;
          case "runtime-drift-image":
          case "runtime-drift-environment":
          case "runtime-drift-ports":
          case "runtime-drift-volumes":
          case "runtime-drift-networks":
            throw new Error(`Runtime drift rule ${ruleId} is not statically evaluated`);
          default: {
            const _exhaustive: never = ruleId;
            throw new Error(`Unhandled rule id: ${_exhaustive}`);
          }
        }

        const result = evaluateLint(composeConfig({ app: service }), undefined, []);

        const expectedGroup = expectedSeverity === "info" ? "review_first" : "recommended";

        expect(result.findings).toEqual([
          expect.objectContaining({
            ruleId,
            service: "app",
            severity: expectedSeverity,
            group: expectedGroup,
          }),
        ]);
      },
    );
  });

  describe("finding groups", () => {
    it.each(LINT_RULES.map((rule) => [rule.id, rule.severity] as const))(
      "classifies %s as %s → %s group",
      (ruleId, severity) => {
        const expectedGroup = severity === "info" ? "review_first" : "recommended";
        expect(classifyFindingGroup({ severity })).toBe(expectedGroup);

        const service = compliantService();
        if (ruleId === "privileged-enabled") {
          service.privileged = true;
        } else if (ruleId === "restart-policy-missing") {
          delete service.restart;
        } else if (ruleId === "healthcheck-missing") {
          delete service.healthcheck;
        } else if (ruleId === "log-rotation-missing") {
          delete service.logging;
        } else if (ruleId === "resource-limits-missing") {
          service.deploy = { resources: { limits: {} } };
        } else if (ruleId === "no-new-privileges-missing") {
          service.security_opt = [];
        } else if (ruleId === "cap-drop-missing") {
          delete service.cap_drop;
        } else if (ruleId === "read-only-rootfs") {
          service.read_only = false;
        }

        const result = evaluateLint(composeConfig({ app: service }), undefined, []);
        const finding = result.findings.find((entry) => entry.ruleId === ruleId);
        expect(finding?.group).toBe(expectedGroup);
      },
    );
  });

  describe("context note heuristics", () => {
    it("adds a writable-volume note for read-only-rootfs on authentik-server-like services", () => {
      const service: LintComposeService = {
        ...compliantService(),
        read_only: false,
        volumes: ["${DOCKER_DIR}/authentik:/config", { target: "/media", read_only: true }],
      };

      expect(hasWritableBindMounts(service)).toBe(true);
      expect(buildContextNote("read-only-rootfs", service)).toContain(
        "Writable bind mounts detected",
      );

      const result = evaluateLint(composeConfig({ "authentik-server": service }), undefined, []);
      const finding = result.findings.find((entry) => entry.ruleId === "read-only-rootfs");
      expect(finding?.group).toBe("review_first");
      expect(finding?.contextNote).toContain("Writable bind mounts detected");
    });

    it("adds cap_add and device notes for cap-drop-missing on cloudflared-like services", () => {
      const service: LintComposeService = {
        ...compliantService(),
        cap_drop: undefined,
        cap_add: ["NET_ADMIN"],
        devices: ["/dev/net/tun"],
      };

      expect(buildContextNote("cap-drop-missing", service)).toContain("cap_add");
      expect(buildContextNote("cap-drop-missing", service)).toContain("Device mounts present");

      const result = evaluateLint(composeConfig({ cloudflared: service }), undefined, []);
      const finding = result.findings.find((entry) => entry.ruleId === "cap-drop-missing");
      expect(finding?.group).toBe("review_first");
      expect(finding?.contextNote).toContain("cap_add");
    });

    it("adds a root-user note for no-new-privileges-missing when user is unset", () => {
      const service: LintComposeService = {
        ...compliantService(),
        security_opt: [],
        user: undefined,
      };

      const result = evaluateLint(composeConfig({ app: service }), undefined, []);
      const finding = result.findings.find((entry) => entry.ruleId === "no-new-privileges-missing");
      expect(finding?.contextNote).toContain("Runs as root");
    });

    it("adds a data-store note for resource-limits-missing on database images", () => {
      const service: LintComposeService = {
        ...compliantService(),
        image: "postgres:16",
        deploy: { resources: { limits: {} } },
      };

      const result = evaluateLint(composeConfig({ "authentik-db": service }), undefined, []);
      const finding = result.findings.find((entry) => entry.ruleId === "resource-limits-missing");
      expect(finding?.contextNote).toContain("Database/cache image");
    });

    it("omits context notes on compliant services without heuristic signals", () => {
      const result = evaluateLint(composeConfig({ app: compliantService() }), undefined, []);

      expect(result.findings).toEqual([]);
    });

    it("omits context notes on info findings without matching signals", () => {
      const service: LintComposeService = {
        ...compliantService(),
        read_only: false,
        user: "1000:1000",
        image: "nginx:alpine",
      };

      const result = evaluateLint(composeConfig({ app: service }), undefined, []);

      for (const finding of result.findings) {
        if (finding.severity === "info") {
          expect(finding.group).toBe("review_first");
          expect(finding.contextNote).toBeUndefined();
        }
      }
    });
  });

  describe("privileged-enabled", () => {
    it("fires when privileged mode is enabled", () => {
      const result = evaluateLint(
        composeConfig({
          app: { ...compliantService(), privileged: true },
        }),
        undefined,
        [],
      );

      expect(findingRuleIds(result, "app")).toContain("privileged-enabled");
    });

    it("passes when privileged mode is not enabled", () => {
      const result = evaluateLint(composeConfig({ app: compliantService() }), undefined, []);

      expect(findingRuleIds(result, "app")).not.toContain("privileged-enabled");
    });
  });

  describe("restart-policy-missing", () => {
    it("fires when neither restart nor deploy.restart_policy is set", () => {
      const service = compliantService();
      delete service.restart;

      const result = evaluateLint(composeConfig({ app: service }), undefined, []);

      expect(findingRuleIds(result, "app")).toContain("restart-policy-missing");
    });

    it("passes when top-level restart is set", () => {
      const result = evaluateLint(composeConfig({ app: compliantService() }), undefined, []);

      expect(findingRuleIds(result, "app")).not.toContain("restart-policy-missing");
    });
  });

  describe("healthcheck-missing", () => {
    it("fires when healthcheck is absent", () => {
      const service = compliantService();
      delete service.healthcheck;

      const result = evaluateLint(composeConfig({ app: service }), undefined, []);

      expect(findingRuleIds(result, "app")).toContain("healthcheck-missing");
    });

    it("passes when healthcheck is configured", () => {
      const result = evaluateLint(composeConfig({ app: compliantService() }), undefined, []);

      expect(findingRuleIds(result, "app")).not.toContain("healthcheck-missing");
    });
  });

  describe("log-rotation-missing", () => {
    it("fires when logging max-size is not configured", () => {
      const service = compliantService();
      delete service.logging;

      const result = evaluateLint(composeConfig({ app: service }), undefined, []);

      expect(findingRuleIds(result, "app")).toContain("log-rotation-missing");
    });

    it("passes when logging max-size is configured", () => {
      const result = evaluateLint(composeConfig({ app: compliantService() }), undefined, []);

      expect(findingRuleIds(result, "app")).not.toContain("log-rotation-missing");
    });
  });

  describe("resource-limits-missing", () => {
    it("fires when deploy.resources.limits.memory is absent", () => {
      const service = compliantService();
      service.deploy = { resources: { limits: {} } };

      const result = evaluateLint(composeConfig({ app: service }), undefined, []);

      expect(findingRuleIds(result, "app")).toContain("resource-limits-missing");
    });

    it("passes when deploy.resources.limits.memory is set", () => {
      const result = evaluateLint(composeConfig({ app: compliantService() }), undefined, []);

      expect(findingRuleIds(result, "app")).not.toContain("resource-limits-missing");
    });
  });

  describe("no-new-privileges-missing", () => {
    it("fires when no-new-privileges security_opt is absent", () => {
      const service = compliantService();
      service.security_opt = [];

      const result = evaluateLint(composeConfig({ app: service }), undefined, []);

      expect(findingRuleIds(result, "app")).toContain("no-new-privileges-missing");
    });

    it("passes when no-new-privileges security_opt is set", () => {
      const result = evaluateLint(composeConfig({ app: compliantService() }), undefined, []);

      expect(findingRuleIds(result, "app")).not.toContain("no-new-privileges-missing");
    });
  });

  describe("cap-drop-missing", () => {
    it("fires when cap_drop is absent or empty", () => {
      const service = compliantService();
      service.cap_drop = [];

      const result = evaluateLint(composeConfig({ app: service }), undefined, []);

      expect(findingRuleIds(result, "app")).toContain("cap-drop-missing");
    });

    it("passes when cap_drop is configured", () => {
      const result = evaluateLint(composeConfig({ app: compliantService() }), undefined, []);

      expect(findingRuleIds(result, "app")).not.toContain("cap-drop-missing");
    });
  });

  describe("read-only-rootfs", () => {
    it("fires when read_only is not true", () => {
      const service = compliantService();
      service.read_only = false;

      const result = evaluateLint(composeConfig({ app: service }), undefined, []);

      expect(findingRuleIds(result, "app")).toContain("read-only-rootfs");
    });

    it("passes when read_only is true", () => {
      const result = evaluateLint(composeConfig({ app: compliantService() }), undefined, []);

      expect(findingRuleIds(result, "app")).not.toContain("read-only-rootfs");
    });
  });

  describe("suppression", () => {
    const nonCompliant: LintComposeService = {};

    it("suppresses findings globally by rule id", () => {
      const result = evaluateLint(composeConfig({ app: nonCompliant }), undefined, [
        { rule: "healthcheck-missing" },
      ]);

      expect(result.findings.some((f) => f.ruleId === "healthcheck-missing")).toBe(false);
      expect(result.findings.length).toBeGreaterThan(0);
    });

    it("suppresses findings for a specific service and rule", () => {
      const result = evaluateLint(
        composeConfig({
          keep: nonCompliant,
          suppress: nonCompliant,
        }),
        undefined,
        [{ rule: "healthcheck-missing", service: "suppress" }],
      );

      expect(
        result.findings.some((f) => f.ruleId === "healthcheck-missing" && f.service === "suppress"),
      ).toBe(false);
      expect(
        result.findings.some((f) => f.ruleId === "healthcheck-missing" && f.service === "keep"),
      ).toBe(true);
    });

    it('suppresses all rules when ignore rule is "*"', () => {
      const result = evaluateLint(composeConfig({ app: nonCompliant }), undefined, [{ rule: "*" }]);

      expect(result.findings).toEqual([]);
      expect(result.summary.total).toBe(0);
    });
  });

  describe("ignore validation", () => {
    it("throws InvalidArgumentError for an unknown ignore rule id", () => {
      expect(() =>
        evaluateLint(composeConfig({ app: {} }), undefined, [
          { rule: "not-a-real-rule" as LintRuleId },
        ]),
      ).toThrow(InvalidArgumentError);

      expect(() =>
        evaluateLint(composeConfig({ app: {} }), undefined, [
          { rule: "not-a-real-rule" as LintRuleId },
        ]),
      ).toThrow(/unknown lint rule id/);
    });
  });

  describe("determinism", () => {
    it("returns identical finding order on repeated evaluation", () => {
      const config = composeConfig({
        zebra: {},
        alpha: { privileged: true },
        middle: { read_only: false },
      });

      const first = evaluateLint(config, undefined, []);
      const second = evaluateLint(config, undefined, []);

      expect(first.findings).toEqual(second.findings);

      const services = first.findings.map((finding) => finding.service);
      expect(services).toEqual([...services].sort((a, b) => a.localeCompare(b)));

      for (let index = 1; index < first.findings.length; index += 1) {
        const previous = first.findings[index - 1];
        const current = first.findings[index];
        if (previous === undefined || current === undefined) {
          continue;
        }

        const serviceCompare = previous.service.localeCompare(current.service);
        if (serviceCompare === 0) {
          expect(previous.ruleId.localeCompare(current.ruleId)).toBeLessThanOrEqual(0);
        } else {
          expect(serviceCompare).toBeLessThan(0);
        }
      }
    });
  });

  describe("anchor-resolved configuration", () => {
    it("does not report restart-policy-missing when anchor-supplied restart is present", () => {
      const service = compliantService();
      delete service.deploy;

      const result = evaluateLint(composeConfig({ fromAnchor: service }), undefined, []);

      expect(findingRuleIds(result, "fromAnchor")).not.toContain("restart-policy-missing");
    });

    it("does not report restart-policy-missing when deploy.restart_policy is present", () => {
      const service: LintComposeService = {
        ...compliantService(),
        restart: undefined,
        deploy: {
          resources: { limits: { memory: "512M" } },
          restart_policy: { condition: "any" },
        },
      };

      const result = evaluateLint(composeConfig({ fromAnchor: service }), undefined, []);

      expect(findingRuleIds(result, "fromAnchor")).not.toContain("restart-policy-missing");
    });
  });
});
