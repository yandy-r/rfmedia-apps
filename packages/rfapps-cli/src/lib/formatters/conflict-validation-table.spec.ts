import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConflictValidationResult } from "../../types/validation.js";
import { projectConflictValidationTable } from "./conflict-validation-table.js";
import { renderTable } from "./table.js";

const result = {
  schemaVersion: "conflict-validation.v1",
  status: "blocked",
  scope: {
    project: "rfapps",
    services: ["web"],
    profiles: ["core"],
  },
  checks: [
    {
      id: "compose",
      status: "passed",
      required: true,
      resources: 1,
    },
  ],
  summary: {
    total: 2,
    errors: 1,
    warnings: 1,
    ports: 2,
    volumes: 0,
    networks: 0,
  },
  conflicts: [
    {
      id: "port-web-other",
      code: "PORT_BINDING_CONFLICT",
      severity: "error",
      origin: "runtime",
      kind: "port",
      message: "Published port 8080 is already owned.",
      resource: {
        kind: "port",
        family: "ipv4",
        hostIp: "0.0.0.0",
        protocol: "tcp",
        published: { start: 8080, end: 8080 },
      },
      parties: [
        {
          kind: "port",
          origin: "desired",
          ownerType: "service",
          name: "web",
          project: "rfapps",
          service: "web",
          claim: {
            kind: "port",
            origin: "desired",
            project: "rfapps",
            service: "web",
            family: "ipv4",
            hostIp: "0.0.0.0",
            protocol: "tcp",
            allocation: {
              mode: "fixed",
              published: { start: 8080, end: 8080 },
            },
          },
        },
        {
          kind: "port",
          origin: "runtime",
          ownerType: "container",
          name: "other",
          containerId: "container-id",
          claim: {
            kind: "port",
            origin: "runtime",
            containerId: "container-id",
            containerName: "other",
            family: "ipv4",
            hostIp: "0.0.0.0",
            protocol: "tcp",
            published: { start: 8080, end: 8080 },
          },
        },
      ],
      resolutions: [
        {
          id: "change-web-port",
          action: "change-compose-port",
          service: "web",
          suggestedPort: 8081,
          message: "Change the Compose published port for web.",
        },
      ],
    },
  ],
  warnings: [
    {
      id: "dynamic-web-port",
      code: "DYNAMIC_PORT_ALLOCATION",
      severity: "warning",
      origin: "desired",
      kind: "port",
      message: "A dynamic port cannot be predicted.",
      resource: {
        kind: "port",
        family: "ipv4",
        hostIp: "0.0.0.0",
        protocol: "tcp",
        published: { start: 0, end: 0 },
      },
      parties: [],
      resolutions: [],
    },
  ],
  limitations: [
    {
      code: "POINT_IN_TIME_SNAPSHOT",
      message: "Docker resources can change after inspection.",
    },
  ],
} satisfies ConflictValidationResult;

describe("projectConflictValidationTable", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("preserves the decision, scope, owners, resolutions, warnings, and limitations in the real table renderer", () => {
    renderTable(projectConflictValidationTable(result), ["field", "value"]);

    const output = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(output).toContain("BLOCKED");
    expect(output).toContain("rfapps");
    expect(output).toContain("web");
    expect(output).toContain("core");
    expect(output).toContain("desired service rfapps/web");
    expect(output).toContain("runtime container other");
    expect(output).toContain("Change the Compose published port for web.");
    expect(output).toContain("A dynamic port cannot be predicted.");
    expect(output).toContain("Docker resources can change after inspection.");
    expect(output).toContain("POINT_IN_TIME_SNAPSHOT");
  });
});
