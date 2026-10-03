/**
 * Default `SecurityScanDependencies` wiring tests.
 *
 * Isolated in its own file so the two module-level mocks below cannot leak into
 * the dependency-injected cases in `security-scan.spec.ts`.
 */

import { describe, expect, it, vi } from "vitest";

import { checkExternalTool } from "@rfmedia/common";
import { execWithEnv } from "./env-tools.js";
import { runSecurityScan } from "./security-scan.js";
import type { ResolvedScanSettings, ScanScope, ScanTarget } from "../types/security-scan.js";

// Partial mocks, modelled on lib/config.test.ts:26-32. Only the exec boundary is
// replaced; the logger and every other rf-common export stay real.
vi.mock("@rfmedia/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rfmedia/common")>();
  return { ...actual, checkExternalTool: vi.fn() };
});
vi.mock("./env-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env-tools.js")>();
  return { ...actual, execWithEnv: vi.fn() };
});

const SCOPE: ScanScope = { services: ["plex"], profiles: ["media"], composePath: "compose.yml" };
const SETTINGS: ResolvedScanSettings = {
  scanner: "trivy",
  failOn: "none",
  ignore: [],
  timeoutMs: 180_000,
  maxTargets: 64,
  concurrency: 2,
  cwd: "/srv/rfmedia-apps",
};

describe("default scan dependencies", () => {
  it("hands the scanner no env-tool injection", async () => {
    vi.mocked(checkExternalTool).mockResolvedValue({ available: true, version: "0.58.1" });
    vi.mocked(execWithEnv).mockResolvedValue({ code: 0, stdout: "{}", stderr: "", success: true });

    const target: ScanTarget = { service: "plex", image: "lscr.io/linuxserver/plex:1.41.3" };
    await runSecurityScan([target], [], SCOPE, SETTINGS);

    expect(vi.mocked(execWithEnv).mock.calls[0]?.[2]).toMatchObject({
      tool: "none",
      cwd: "/srv/rfmedia-apps",
      timeout: 180_000,
    });
  });
});
