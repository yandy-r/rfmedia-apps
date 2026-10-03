/**
 * Compose security audit engine tests.
 */

import { describe, expect, it } from "vitest";

import { InvalidArgumentError } from "./errors.js";
import {
  AUDIT_RULES,
  evaluateSecurityAudit,
  formatAuditText,
  parseAuditFailOn,
  shouldFailAudit,
} from "./security-audit.js";
import { AUDIT_SCHEMA_VERSION } from "../types/audit.js";
import type { AuditComposeConfig, AuditComposeService, AuditResult } from "../types/audit.js";

function compliantService(): AuditComposeService {
  return {
    user: "1000:1000",
    cap_drop: ["ALL"],
    deploy: {
      resources: {
        limits: {
          memory: "512M",
          cpus: "0.5",
        },
      },
    },
  };
}

function composeConfig(services: Record<string, AuditComposeService>): AuditComposeConfig {
  return { services };
}

function resultFor(services: Record<string, AuditComposeService>) {
  return evaluateSecurityAudit(composeConfig(services), undefined);
}

describe("evaluateSecurityAudit", () => {
  it("defines stable v1 security audit rules", () => {
    expect(AUDIT_RULES.map((rule) => rule.id)).toEqual([
      "privileged-container",
      "docker-socket-mounted",
      "host-networking",
      "root-user",
      "capability-added",
      "cap-drop-missing",
      "service-networking",
      "memory-limit-missing",
      "cpu-limit-missing",
    ]);
  });

  it.each([undefined, "", "root", "0", "0:0", "0:1000", "root:0", "root:1000"] as Array<
    string | undefined
  >)("flags root-equivalent user %s", (user) => {
    const service = compliantService();
    service.user = user;

    const result = resultFor({ app: service });

    expect(result.findings).toEqual([
      expect.objectContaining({
        ruleId: "root-user",
        service: "app",
        evidence: expect.arrayContaining([
          user === undefined ? "user=<omitted>" : user === "" ? "user=<empty>" : `user=${user}`,
        ]),
      }),
    ]);
  });

  it.each(["${PUID}:${PGID}", "1000:1000", "node"])("allows non-root user %s", (user) => {
    const result = resultFor({ app: { ...compliantService(), user } });

    expect(result.findings.map((finding) => finding.ruleId)).not.toContain("root-user");
  });

  it("flags privileged mode, added capabilities, missing cap drops, and resource limits", () => {
    const result = resultFor({
      app: {
        user: "1000:1000",
        privileged: true,
        cap_add: ["NET_ADMIN"],
        deploy: { resources: { limits: {} } },
      },
    });

    expect(result.findings.map((finding) => finding.ruleId)).toEqual([
      "privileged-container",
      "capability-added",
      "cap-drop-missing",
      "cpu-limit-missing",
      "memory-limit-missing",
    ]);
    expect(result.summary).toMatchObject({ critical: 1, warn: 1, info: 3, total: 5 });
  });

  it("detects Docker socket mounts in short and long volume syntax", () => {
    const result = resultFor({
      short: {
        ...compliantService(),
        volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"],
      },
      long: {
        ...compliantService(),
        volumes: [{ type: "bind", source: "/tmp/socket-proxy", target: "/var/run/docker.sock" }],
      },
    });

    expect(result.findings).toEqual([
      expect.objectContaining({ ruleId: "docker-socket-mounted", service: "long" }),
      expect.objectContaining({ ruleId: "docker-socket-mounted", service: "short" }),
    ]);
  });

  it("distinguishes host networking from service namespace sharing", () => {
    const result = resultFor({
      host: { ...compliantService(), network_mode: "host" },
      sidecar: { ...compliantService(), network_mode: "service:plex-ts" },
    });

    expect(result.findings).toEqual([
      expect.objectContaining({ ruleId: "host-networking", service: "host" }),
      expect.objectContaining({ ruleId: "service-networking", service: "sidecar" }),
    ]);
  });

  it("filters target services and rejects missing targets", () => {
    const config = composeConfig({
      app: { ...compliantService(), privileged: true },
      db: { ...compliantService(), privileged: true },
    });

    expect(evaluateSecurityAudit(config, ["db"]).findings).toEqual([
      expect.objectContaining({ service: "db" }),
    ]);
    expect(() => evaluateSecurityAudit(config, ["missing"])).toThrow(InvalidArgumentError);
  });

  it("sorts deterministically by severity, category, rule, and service", () => {
    const result = resultFor({
      zed: { ...compliantService(), privileged: true },
      app: { ...compliantService(), network_mode: "host" },
      mid: { ...compliantService(), user: "0" },
    });

    expect(
      result.findings.map((finding) => `${finding.severity}:${finding.ruleId}:${finding.service}`),
    ).toEqual([
      "critical:privileged-container:zed",
      "error:host-networking:app",
      "warn:root-user:mid",
    ]);
  });

  it("keeps evidence bounded and excludes raw service objects", () => {
    const result = resultFor({
      app: {
        ...compliantService(),
        user: "0:0",
        volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
      },
    });

    for (const finding of result.findings) {
      expect(finding.evidence.every((entry) => typeof entry === "string")).toBe(true);
      expect(JSON.stringify(finding.evidence)).not.toContain("SECRET_TOKEN");
      expect(JSON.stringify(finding.evidence)).not.toContain("{");
    }
  });

  it.each(["none", "info", "warn", "error", "critical"] as const)(
    "parses fail threshold %s",
    (threshold) => {
      expect(parseAuditFailOn(threshold)).toBe(threshold);
    },
  );

  it("applies fail thresholds at or above selected severity", () => {
    const audit = evaluateSecurityAudit(
      composeConfig({ app: { ...compliantService(), user: "0" } }),
      undefined,
    );
    const result: AuditResult = {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      timestamp: audit.timestamp,
      scope: { services: [], profiles: [], composePath: "compose.yml" },
      summary: audit.summary,
      findings: audit.findings,
    };

    expect(shouldFailAudit(result, "none")).toBe(false);
    expect(shouldFailAudit(result, "info")).toBe(true);
    expect(shouldFailAudit(result, "warn")).toBe(true);
    expect(shouldFailAudit(result, "error")).toBe(false);
  });

  it("formats text grouped by severity and service", () => {
    const audit = evaluateSecurityAudit(
      composeConfig({ app: { ...compliantService(), privileged: true } }),
      undefined,
    );
    const lines = formatAuditText({
      schemaVersion: AUDIT_SCHEMA_VERSION,
      timestamp: audit.timestamp,
      scope: { services: [], profiles: [], composePath: "compose.yml" },
      summary: audit.summary,
      findings: audit.findings,
    });

    expect(lines.join("\n")).toContain("Security Audit Summary");
    expect(lines.join("\n")).toContain("CRITICAL");
    expect(lines.join("\n")).toContain("app");
    expect(lines.join("\n")).toContain("Remediation:");
  });
});
