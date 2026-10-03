import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import { executeLint } from "./lint.js";
import * as driftLib from "../lib/drift.js";
import * as dockerLib from "../lib/docker.js";
import { formatOutput } from "../lib/formatters/index.js";
import * as lib from "../lib/index.js";
import { LINT_RULES } from "../lib/lint.js";

vi.mock("../lib/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/index.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(),
    applyCliOverrides: vi.fn(),
    isValidProfile: vi.fn(),
    resolveServicesWithInteractive: vi.fn(),
  };
});
vi.mock("../lib/docker.js");
vi.mock("../lib/drift.js");
vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@rfmedia/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rfmedia/common")>();
  return {
    ...actual,
    isMachineFormat: vi.fn(),
    formatError: vi.fn(),
    outputFormattedError: vi.fn(),
    logDebug: vi.fn(),
  };
});

describe("Lint Action", () => {
  const mockConfig = {
    composePath: "compose.yml",
    envFile: ".env",
    profiles: {
      defaultProfile: "core",
      validProfiles: ["core", "all"],
      mapping: {},
    },
    sidecars: {
      enabled: true,
      mapping: {},
    },
    groups: {},
    healthCheck: {
      timeout: 60,
      interval: 1,
      retries: 2,
      waitForReady: true,
    },
    envTool: {
      tool: "none",
    },
    docker: {},
    interactive: { pageSize: 10 },
    state: { enabled: true },
    parallel: {
      enabled: false,
      workers: 4,
    },
    lint: {
      ignore: [],
    },
  };

  const mockComposeConfig = {
    services: {
      app: {
        image: "nginx:latest",
        privileged: true,
      },
    },
  };

  const mockComposeConfigWarnOnly = {
    services: {
      app: {
        image: "nginx:latest",
      },
    },
  };

  let originalExitCode: typeof process.exitCode;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["app"],
      profiles: ["core"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(dockerLib.getComposeConfig).mockResolvedValue(mockComposeConfig as any);
    vi.mocked(dockerLib.getRunningServiceContainerMap).mockResolvedValue(
      new Map([["app", "app-container"]]),
    );
    vi.mocked(dockerLib.inspectContainers).mockResolvedValue([]);
    vi.mocked(driftLib.detectDrift).mockResolvedValue({
      timestamp: "now",
      composePath: "compose.yml",
      services: [],
      summary: {
        total: 0,
        drifted: 0,
        unchanged: 0,
        directions: { composeAhead: 0, containerAhead: 0, diverged: 0 },
      },
    } as any);
    vi.mocked(common.isMachineFormat).mockReturnValue(false);
    vi.mocked(common.formatError).mockReturnValue({
      message: "formatted error",
      suggestions: [],
      exitCode: 1,
      originalError: new Error("formatted error"),
    });
    vi.mocked(common.outputFormattedError).mockReturnValue(undefined);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    consoleErrorSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  });

  describe("format dispatch", () => {
    it("should not call formatOutput for text format (default)", async () => {
      await executeLint({}, {});

      expect(formatOutput).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(
        consoleErrorSpy.mock.calls.some(([message]: [unknown]) =>
          String(message).includes("Production Readiness Lint"),
        ),
      ).toBe(true);
    });

    it("should call formatOutput with json format when --json is passed", async () => {
      await executeLint({ json: true }, {});

      expect(formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          mode: "static",
          findings: expect.arrayContaining([
            expect.objectContaining({
              service: "app",
              ruleId: "privileged-enabled",
              severity: "error",
            }),
          ]),
          summary: expect.objectContaining({
            error: 1,
            total: expect.any(Number),
          }),
        }),
      );
    });

    it("should emit SARIF to stdout without calling formatOutput", async () => {
      await executeLint({ sarif: true }, {});

      expect(formatOutput).not.toHaveBeenCalled();
      expect(stdoutWriteSpy).toHaveBeenCalled();

      const written = String(stdoutWriteSpy.mock.calls[0]?.[0] ?? "");
      const sarif = JSON.parse(written.trim()) as {
        version: string;
        runs: Array<{ tool: { driver: { name: string } }; results: unknown[] }>;
      };

      expect(sarif.version).toBe("2.1.0");
      expect(sarif.runs[0]?.tool.driver.name).toBe("rfapps-lint");
      expect(sarif.runs[0]?.results.length).toBeGreaterThan(0);
    });
  });

  describe("--list-rules", () => {
    it("should print the rule catalog and skip compose config resolution", async () => {
      await executeLint({ listRules: true }, {});

      expect(dockerLib.getComposeConfig).not.toHaveBeenCalled();
      expect(lib.loadConfig).not.toHaveBeenCalled();
      expect(formatOutput).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Production Readiness Lint Rules"),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `${LINT_RULES[0]?.id} | ${LINT_RULES[0]?.severity} | ${LINT_RULES[0]?.rationale}`,
      );
    });
  });

  describe("--fail-on", () => {
    it("should set process.exitCode when findings meet the fail-on threshold", async () => {
      await executeLint({ failOn: "error" }, {});

      expect(process.exitCode).toBe(1);
    });

    it("should set process.exitCode to success when findings are below the fail-on threshold", async () => {
      vi.mocked(dockerLib.getComposeConfig).mockResolvedValue(mockComposeConfigWarnOnly as any);

      await executeLint({ failOn: "error" }, {});

      expect(process.exitCode).toBe(0);
    });

    it("should set process.exitCode to success when fail-on is none even with error findings", async () => {
      await executeLint({ failOn: "none" }, {});

      expect(process.exitCode).toBe(0);
    });
  });

  describe("grouped text output", () => {
    it("should show advisory banner and section headers for review_first findings", async () => {
      await executeLint({}, {});

      const messages = consoleErrorSpy.mock.calls.map(([message]: [unknown]) => String(message));
      const combined = messages.join("\n");

      expect(combined).toContain("Optional hardening (review first)");
      expect(combined).toContain("Recommended");
      expect(combined).toContain("Findings are advisory");
    });

    it("should include group on JSON findings", async () => {
      await executeLint({ json: true }, {});

      expect(formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({
              service: "app",
              ruleId: "privileged-enabled",
              group: "recommended",
            }),
          ]),
        }),
      );
    });

    it("should print catalog advisory note for --list-rules", async () => {
      await executeLint({ listRules: true }, {});

      const messages = consoleErrorSpy.mock.calls.map(([message]: [unknown]) => String(message));
      expect(messages.some((message: string) => message.includes("optional hardening"))).toBe(true);
    });
  });

  describe("context notes in text output", () => {
    it("should print note lines when contextNote is present on findings", async () => {
      vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
        services: ["cloudflared"],
        profiles: ["core"],
        preSidecarCount: 1,
        sidecarsExpanded: false,
      });
      vi.mocked(dockerLib.getComposeConfig).mockResolvedValue({
        services: {
          cloudflared: {
            image: "cloudflare/cloudflared:latest",
            restart: "unless-stopped",
            healthcheck: { test: ["CMD", "true"] },
            logging: { options: { "max-size": "10m" } },
            deploy: { resources: { limits: { memory: "512M" } } },
            security_opt: ["no-new-privileges:true"],
            cap_add: ["NET_ADMIN"],
            devices: ["/dev/net/tun"],
          },
        },
      } as any);

      await executeLint({}, {});

      const messages = consoleErrorSpy.mock.calls.map(([message]: [unknown]) => String(message));
      const combined = messages.join("\n");

      expect(combined).toContain("note:");
      expect(combined).toContain("cap_add");
    });
  });

  describe("--runtime", () => {
    it("should invoke inspectContainers when runtime mode is enabled", async () => {
      await executeLint({ runtime: true }, {});

      expect(dockerLib.getRunningServiceContainerMap).toHaveBeenCalled();
      expect(dockerLib.inspectContainers).toHaveBeenCalledWith(["app-container"], {
        envTool: undefined,
      });
      expect(driftLib.detectDrift).toHaveBeenCalled();
    });

    it("should not invoke inspectContainers in default static mode", async () => {
      await executeLint({}, {});

      expect(dockerLib.getComposeConfig).toHaveBeenCalled();
      expect(dockerLib.getRunningServiceContainerMap).not.toHaveBeenCalled();
      expect(dockerLib.inspectContainers).not.toHaveBeenCalled();
      expect(driftLib.detectDrift).not.toHaveBeenCalled();
    });
  });
});
