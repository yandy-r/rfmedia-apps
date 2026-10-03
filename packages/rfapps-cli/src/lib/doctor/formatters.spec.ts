import { describe, expect, it, vi } from "vitest";

import { formatDoctorText } from "./formatters.js";
import type { DoctorResult } from "../../types/doctor.js";

vi.mock("@rfmedia/common", () => {
  const passthrough = (value: string | number | null | undefined) => String(value);
  return {
    colors: {
      bold: passthrough,
      red: passthrough,
      yellow: passthrough,
      gray: passthrough,
      green: passthrough,
      cyan: passthrough,
    },
  };
});

describe("formatDoctorText", () => {
  it("renders grouped summary, findings, evidence, and next command", () => {
    const result: DoctorResult = {
      schemaVersion: "doctor.v1",
      timestamp: "2026-06-10T00:00:00.000Z",
      scope: {
        services: ["plex"],
        profiles: ["media"],
        composePath: "compose.yml",
        checkUpdates: false,
      },
      summary: { critical: 0, error: 1, warn: 0, info: 0, total: 1 },
      checks: [{ id: "runtime-status", category: "runtime", status: "run" }],
      findings: [
        {
          id: "runtime.unhealthy",
          severity: "error",
          category: "runtime",
          service: "plex",
          message: "Container is unhealthy",
          evidence: ["health=unhealthy"],
          suggestedCommand: "rfapps health -s plex --no-wait-for-ready",
        },
      ],
    };

    const lines = formatDoctorText(result);

    expect(lines.join("\n")).toContain("Doctor Summary");
    expect(lines.join("\n")).toContain("error    runtime  plex");
    expect(lines.join("\n")).toContain("evidence: health=unhealthy");
    expect(lines.join("\n")).toContain("next: rfapps health -s plex --no-wait-for-ready");
  });

  it("renders skipped checks and no findings", () => {
    const result: DoctorResult = {
      schemaVersion: "doctor.v1",
      timestamp: "2026-06-10T00:00:00.000Z",
      scope: { services: [], profiles: ["all"], composePath: "compose.yml", checkUpdates: false },
      summary: { critical: 0, error: 0, warn: 0, info: 0, total: 0 },
      checks: [
        { id: "image-updates", category: "updates", status: "skipped", message: "requires flag" },
      ],
      findings: [],
    };

    expect(formatDoctorText(result).join("\n")).toContain("No findings");
    expect(formatDoctorText(result).join("\n")).toContain("image-updates: requires flag");
  });
});
