import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executeDriftDetect,
  executeDriftShow,
  executeDriftReconcile,
  executeDriftImport,
} from "./drift.js";
import * as driftLib from "../lib/drift.js";
import * as lib from "../lib/index.js";
import * as common from "@rfmedia/common";
import * as fs from "node:fs/promises";
import { InvalidArgumentError } from "../lib/errors.js";
import * as reconcileAction from "./reconcile.js";

// Mock dependencies
vi.mock("../lib/drift.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/drift.js")>();
  return {
    ...actual,
    detectDrift: vi.fn(),
    getDriftForService: vi.fn(),
  };
});
vi.mock("../lib/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/index.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(),
    applyCliOverrides: vi.fn(),
    isValidProfile: vi.fn(),
    formatOutput: vi.fn(),
    resolveServicesWithInteractive: vi.fn(),
    autoDetectProfiles: vi.fn(),
    startServices: vi.fn(),
  };
});
vi.mock("./reconcile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reconcile.js")>();
  return {
    ...actual,
    executeReconcile: vi.fn(),
  };
});
vi.mock("@rfmedia/common");
vi.mock("node:fs/promises");

describe("Drift Actions", () => {
  const mockConfig = {
    composePath: "compose.yml",
    profiles: { defaultProfile: "core" },
    sidecars: { enabled: true },
  };

  const mockDriftResult = {
    timestamp: "now",
    composePath: "compose.yml",
    services: [],
    summary: {
      total: 0,
      drifted: 0,
      unchanged: 0,
      directions: { composeAhead: 0, containerAhead: 0, diverged: 0 },
    },
  };

  const mockDriftResultWithDrift = {
    timestamp: "now",
    composePath: "compose.yml",
    services: [
      {
        service: "app",
        hasDrift: true,
        direction: "compose_ahead",
        categories: ["image", "runtime-status"],
        image: { changed: true, current: "v1", desired: "v2" },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
        runtimeStatus: {
          current: { state: "exited", health: "unhealthy" },
          desired: { state: "running", health: "healthy" },
          changed: true,
        },
      },
    ],
    summary: {
      total: 1,
      drifted: 1,
      unchanged: 0,
      directions: { composeAhead: 1, containerAhead: 0, diverged: 0 },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.formatOutput).mockResolvedValue(undefined);
    // Default mock for resolveServicesWithInteractive
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: [],
      profiles: ["core"],
      preSidecarCount: 0,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.autoDetectProfiles).mockReturnValue(["core"]);
    vi.mocked(reconcileAction.executeReconcile).mockResolvedValue(undefined);
  });

  describe("executeDriftDetect", () => {
    it("should call formatOutput with json format when --output json is passed", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue(mockDriftResult as any);

      await executeDriftDetect({}, { output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith("json", mockDriftResult);
    });

    it("should call formatOutput with yaml format when --output yaml is passed", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue(mockDriftResult as any);

      await executeDriftDetect({}, { output: "yaml" });

      expect(lib.formatOutput).toHaveBeenCalledWith("yaml", mockDriftResult);
    });

    it("should call formatOutput with csv format when --output csv is passed", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue(mockDriftResult as any);

      await executeDriftDetect({}, { output: "csv" });

      expect(lib.formatOutput).toHaveBeenCalledWith("csv", mockDriftResult);
    });

    it("should not call formatOutput for text format (default)", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue(mockDriftResult as any);

      await executeDriftDetect({}, {});

      expect(lib.formatOutput).not.toHaveBeenCalled();
    });

    it("should display human-readable output for text format with drift", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(driftLib.detectDrift).mockResolvedValue(mockDriftResultWithDrift as any);

      await executeDriftDetect({ showUnchanged: true }, {});

      // Text format renders via console.error, not formatOutput
      expect(lib.formatOutput).not.toHaveBeenCalled();
      expect(common.logSuccess).toHaveBeenCalledWith("Drift detection complete");
      expect(process.exitCode).toBe(1);
      expect(consoleSpy.mock.calls.flat().join("\n")).toContain("runtime-status");
    });

    it("should keep success exit code for detect when report-only is set", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue(mockDriftResultWithDrift as any);

      await executeDriftDetect({ reportOnly: true }, { output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith("json", mockDriftResultWithDrift);
      expect(process.exitCode).toBeUndefined();
    });

    it("should set drift-found exit code after machine output is emitted", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue(mockDriftResultWithDrift as any);

      await executeDriftDetect({}, { output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith("json", mockDriftResultWithDrift);
      expect(process.exitCode).toBe(1);
    });

    it("should show success message when no drift detected in text mode", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue(mockDriftResult as any);

      await executeDriftDetect({}, {});

      expect(common.logSuccess).toHaveBeenCalledWith("No drift detected");
      expect(process.exitCode).toBeUndefined();
    });

    it("should fail if detection fails", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue(undefined);
      vi.mocked(common.formatError).mockReturnValue({
        message: "Docker inspect failed",
        suggestions: [],
        exitCode: 1,
        originalError: new Error("Docker inspect failed"),
      });

      await executeDriftDetect({}, {});

      expect(common.formatError).toHaveBeenCalled();
      expect(common.outputFormattedError).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it("should call formatOutput in dry-run mode with non-text format", async () => {
      await executeDriftDetect({}, { dryRun: true, output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({ dryRun: true }),
      );
    });

    it("should not call mutation helpers during detect", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue(mockDriftResultWithDrift as any);

      await executeDriftDetect({}, { output: "json" });

      expect(lib.startServices).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(fs.copyFile).not.toHaveBeenCalled();
    });
  });

  describe("executeDriftShow", () => {
    it("should require service argument", async () => {
      await expect(executeDriftShow({}, {})).rejects.toThrow(InvalidArgumentError);
    });

    it("should show drift details in text mode", async () => {
      vi.mocked(driftLib.getDriftForService).mockResolvedValue({
        service: "app",
        hasDrift: true,
        direction: "compose_ahead",
        categories: ["image"],
        image: { changed: true, current: "v1", desired: "v2" },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
        runtimeStatus: {
          current: { state: "running", health: "none" },
          desired: { state: "running", health: "none" },
          changed: false,
        },
      } as any);

      await executeDriftShow({ service: "app" }, {});

      // Text format renders via console.error, not formatOutput
      expect(lib.formatOutput).not.toHaveBeenCalled();
      expect(driftLib.getDriftForService).toHaveBeenCalled();
    });

    it("should call formatOutput with json format for drift show", async () => {
      const mockDrift = {
        service: "app",
        hasDrift: true,
        direction: "compose_ahead",
        categories: ["image"],
        image: { changed: true, current: "v1", desired: "v2" },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
      };
      vi.mocked(driftLib.getDriftForService).mockResolvedValue(mockDrift as any);

      await executeDriftShow({ service: "app" }, { output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith("json", {
        service: "app",
        drift: mockDrift,
      });
      expect(process.exitCode).toBe(1);
    });

    it("should keep success exit code for show when report-only is set", async () => {
      const mockDrift = {
        service: "app",
        hasDrift: true,
        direction: "compose_ahead",
        categories: ["image"],
        image: { changed: true, current: "v1", desired: "v2" },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
      };
      vi.mocked(driftLib.getDriftForService).mockResolvedValue(mockDrift as any);

      await executeDriftShow({ service: "app", reportOnly: true }, { output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith("json", {
        service: "app",
        drift: mockDrift,
      });
      expect(process.exitCode).toBeUndefined();
    });

    it("should call formatOutput with yaml format for drift show", async () => {
      const mockDrift = {
        service: "app",
        hasDrift: true,
        direction: "compose_ahead",
        categories: ["image"],
        image: { changed: true, current: "v1", desired: "v2" },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
      };
      vi.mocked(driftLib.getDriftForService).mockResolvedValue(mockDrift as any);

      await executeDriftShow({ service: "app" }, { output: "yaml" });

      expect(lib.formatOutput).toHaveBeenCalledWith("yaml", {
        service: "app",
        drift: mockDrift,
      });
    });

    it("should call formatOutput in dry-run mode with non-text format", async () => {
      await executeDriftShow({ service: "app" }, { dryRun: true, output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({ dryRun: true, service: "app" }),
      );
    });

    it("should not call mutation helpers during show", async () => {
      const mockDrift = {
        service: "app",
        hasDrift: true,
        direction: "compose_ahead",
        categories: ["image"],
        image: { changed: true, current: "v1", desired: "v2" },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
      };
      vi.mocked(driftLib.getDriftForService).mockResolvedValue(mockDrift as any);

      await executeDriftShow({ service: "app" }, { output: "json" });

      expect(lib.startServices).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(fs.copyFile).not.toHaveBeenCalled();
    });
  });

  describe("executeDriftReconcile", () => {
    it("maps every legacy option to the shared action with explicit auto-apply intent", async () => {
      const rawOptions = {
        service: "plex",
        services: "plex,plex-ts",
        group: "media",
        sidecars: false,
        compose: "/project/compose.yml",
        envFile: "/project/.env",
        profile: "media",
      };
      const globalOptions = {
        dryRun: false,
        debug: true,
        json: false,
        output: "yaml" as const,
        verbose: true,
        yes: true,
        useDotenvx: "/project/secrets.env",
      };

      await executeDriftReconcile(rawOptions, globalOptions);

      expect(reconcileAction.executeReconcile).toHaveBeenCalledOnce();
      expect(reconcileAction.executeReconcile).toHaveBeenCalledWith(
        { ...rawOptions, autoApply: true },
        globalOptions,
      );
      expect(lib.startServices).not.toHaveBeenCalled();
    });

    it("delegates machine authorization so mutation without --yes is rejected", async () => {
      const authorizationError = new InvalidArgumentError(
        "--yes",
        "false",
        "Machine-format mutation requires explicit --auto-apply --yes",
      );
      vi.mocked(reconcileAction.executeReconcile).mockRejectedValueOnce(authorizationError);

      await expect(executeDriftReconcile({ service: "app" }, { output: "json" })).rejects.toBe(
        authorizationError,
      );

      expect(reconcileAction.executeReconcile).toHaveBeenCalledWith(
        { service: "app", autoApply: true },
        { output: "json" },
      );
      expect(lib.startServices).not.toHaveBeenCalled();
    });

    it("forwards dry-run unchanged so it remains authoritative over legacy auto-apply", async () => {
      await executeDriftReconcile(
        { services: "app,worker", sidecars: false },
        { dryRun: true, output: "yaml", yes: true },
      );

      expect(reconcileAction.executeReconcile).toHaveBeenCalledWith(
        {
          services: "app,worker",
          sidecars: false,
          autoApply: true,
        },
        { dryRun: true, output: "yaml", yes: true },
      );
      expect(common.confirm).not.toHaveBeenCalled();
      expect(lib.startServices).not.toHaveBeenCalled();
    });

    it("preserves reconcile.v1 output and exit state from the shared action", async () => {
      const result = {
        schemaVersion: "reconcile.v1",
        operation: "reconcile",
        mode: "auto-apply",
        status: "partial",
        exitCode: 3,
      };
      vi.mocked(reconcileAction.executeReconcile).mockImplementationOnce(async () => {
        await lib.formatOutput("json", result);
        process.exitCode = result.exitCode;
      });

      await executeDriftReconcile({ service: "app" }, { output: "json", yes: true });

      expect(lib.formatOutput).toHaveBeenCalledWith("json", result);
      expect(process.exitCode).toBe(3);
      expect(lib.startServices).not.toHaveBeenCalled();
    });
  });

  describe("executeDriftImport", () => {
    it("should import changes to compose file", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue({
        services: [
          {
            service: "app",
            hasDrift: true,
            categories: ["image"],
            image: { changed: true, current: "app:v2" },
            environment: [],
            ports: {},
            volumes: {},
            networks: {},
          },
        ],
        summary: { drifted: 1 },
      } as any);
      vi.mocked(common.confirm).mockResolvedValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("services:\n  app:\n    image: app:v1");
      vi.mocked(fs.writeFile).mockResolvedValue();

      await executeDriftImport({ service: "app" }, {});

      expect(fs.writeFile).toHaveBeenCalled();
      expect(common.logSuccess).toHaveBeenCalledWith("Drift import complete");
    });

    it("should create backup if requested", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue({
        services: [
          {
            service: "app",
            hasDrift: true,
            categories: ["image"],
            image: { changed: true, current: "app:v2" },
            environment: [],
            ports: {},
            volumes: {},
            networks: {},
          },
        ],
        summary: { drifted: 1 },
      } as any);
      vi.mocked(common.confirm).mockResolvedValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("services:\n  app:\n    image: app:v1");
      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.copyFile).mockResolvedValue();

      await executeDriftImport({ service: "app", backup: true }, {});

      expect(fs.copyFile).toHaveBeenCalled();
    });

    it("should skip if no drift to import", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue({
        services: [{ service: "app", hasDrift: false }],
        summary: { drifted: 0 },
      } as any);

      await executeDriftImport({ service: "app" }, {});

      expect(common.logSuccess).toHaveBeenCalledWith("No drift to import");
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("should skip runtime-status-only drift during import", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue({
        services: [
          {
            service: "app",
            hasDrift: true,
            categories: ["runtime-status"],
            image: { changed: false },
            environment: [{ name: "DB_PASSWORD", current: "********", changeType: "unchanged" }],
            ports: {},
            volumes: {},
            networks: {},
            runtimeStatus: { changed: true },
          },
        ],
        summary: { drifted: 1 },
      } as any);

      await executeDriftImport({ service: "app" }, { yes: true });

      expect(common.logSuccess).toHaveBeenCalledWith("No drift to import");
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("should skip confirmation prompt for machine formats", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue({
        services: [
          {
            service: "app",
            hasDrift: true,
            categories: ["image"],
            image: { changed: true, current: "app:v2" },
            environment: [],
            ports: {},
            volumes: {},
            networks: {},
          },
        ],
        summary: { drifted: 1 },
      } as any);
      vi.mocked(common.isMachineFormat).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("services:\n  app:\n    image: app:v1");
      vi.mocked(fs.writeFile).mockResolvedValue();

      await executeDriftImport({ service: "app" }, { output: "json" });

      expect(common.confirm).not.toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it("should call formatOutput in dry-run mode with non-text format", async () => {
      vi.mocked(driftLib.detectDrift).mockResolvedValue({
        services: [
          {
            service: "app",
            hasDrift: true,
            categories: ["image"],
            image: { changed: true, current: "app:v2" },
            environment: [],
            ports: {},
            volumes: {},
            networks: {},
          },
        ],
        summary: { drifted: 1 },
      } as any);

      await executeDriftImport({ service: "app" }, { dryRun: true, output: "csv" });

      expect(lib.formatOutput).toHaveBeenCalledWith(
        "csv",
        expect.objectContaining({ dryRun: true }),
      );
    });
  });
});
