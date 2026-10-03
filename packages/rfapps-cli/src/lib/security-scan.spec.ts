/**
 * Image vulnerability scan engine tests.
 *
 * Every case injects `SecurityScanDependencies` directly — module mocking is
 * deliberately absent here and confined to `security-scan-deps.spec.ts`.
 */

import { describe, expect, it, vi } from "vitest";

import { InvalidArgumentError } from "./errors.js";
import { resolveScanSettings } from "./security-scan-settings.js";
import {
  buildScanSummary,
  evaluateScanGate,
  resolveScanTargets,
  runSecurityScan,
  SCANNER_BACKENDS,
} from "./security-scan.js";
import type {
  ImageScan,
  ResolvedScanSettings,
  ScanConfig,
  ScanScope,
  ScanSeverityCounts,
  ScanTarget,
  ScanVulnerability,
  SecurityScanDependencies,
} from "../types/security-scan.js";

const SCOPE: ScanScope = {
  services: ["plex"],
  profiles: ["media"],
  composePath: "/srv/rfmedia-apps/compose.yml",
};

function settings(overrides: Partial<ResolvedScanSettings> = {}): ResolvedScanSettings {
  return {
    scanner: "trivy",
    failOn: "none",
    ignore: [],
    timeoutMs: 180_000,
    maxTargets: 64,
    concurrency: 2,
    cwd: "/srv/rfmedia-apps",
    ...overrides,
  };
}

function createDependencies(
  overrides: Partial<SecurityScanDependencies> = {},
): SecurityScanDependencies {
  return {
    probeScanner: vi.fn(async () => ({ available: true, version: "0.58.1" })),
    runScanner: vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "", success: true })),
    now: () => new Date("2026-07-30T18:00:00.000Z"),
    elapsedMs: () => 0,
    ...overrides,
  };
}

function trivyReport(entries: ReadonlyArray<Record<string, string>>): string {
  return JSON.stringify({ Results: [{ Target: "plex", Vulnerabilities: entries }] });
}

function grypeReport(matches: readonly unknown[]): string {
  return JSON.stringify({ matches });
}

function vulnerability(overrides: Partial<ScanVulnerability> = {}): ScanVulnerability {
  return {
    id: "CVE-2026-0001",
    severity: "high",
    rawSeverity: "HIGH",
    packageName: "openssl",
    installedVersion: "3.3.1",
    ...overrides,
  };
}

function countsOf(vulnerabilities: readonly ScanVulnerability[]): ScanSeverityCounts {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
  for (const entry of vulnerabilities) counts[entry.severity] += 1;
  return counts;
}

function scannedImage(service: string, vulnerabilities: readonly ScanVulnerability[]): ImageScan {
  return {
    status: "scanned",
    service,
    image: `${service}:latest`,
    counts: countsOf(vulnerabilities),
    vulnerabilities,
    suppressed: 0,
    truncated: false,
    durationMs: 0,
  };
}

function scannedOnly(report: { readonly images: readonly ImageScan[] }, service: string) {
  const image = report.images.find((entry) => entry.service === service);
  if (image?.status !== "scanned") {
    throw new Error(`expected ${service} to be scanned, got ${image?.status ?? "nothing"}`);
  }
  return image;
}

describe("trivy report parsing", () => {
  it("normalizes a realistic report and omits fixedVersion when no fix exists", () => {
    const result = SCANNER_BACKENDS.trivy.parseReport(
      trivyReport([
        {
          VulnerabilityID: "CVE-2026-0001",
          PkgName: "openssl",
          InstalledVersion: "3.3.1",
          FixedVersion: "3.3.2",
          Severity: "HIGH",
          PrimaryURL: "https://avd.aquasec.com/nvd/cve-2026-0001",
        },
        {
          VulnerabilityID: "CVE-2026-0002",
          PkgName: "zlib",
          InstalledVersion: "1.3",
          FixedVersion: "",
          Severity: "MEDIUM",
        },
      ]),
    );

    if (!result.ok) throw new Error(`expected a parsed report, got: ${result.detail}`);
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0]).toEqual({
      id: "CVE-2026-0001",
      severity: "high",
      rawSeverity: "HIGH",
      packageName: "openssl",
      installedVersion: "3.3.1",
      fixedVersion: "3.3.2",
      reference: "https://avd.aquasec.com/nvd/cve-2026-0001",
    });
    expect(result.vulnerabilities[1]).toEqual({
      id: "CVE-2026-0002",
      severity: "medium",
      rawSeverity: "MEDIUM",
      packageName: "zlib",
      installedVersion: "1.3",
    });
    expect(Object.keys(result.vulnerabilities[1] ?? {})).not.toContain("fixedVersion");
  });

  it("rejects empty output", () => {
    const result = SCANNER_BACKENDS.trivy.parseReport("");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.detail).toBe("trivy produced no report output");
  });

  it("accepts a report with no Results key", () => {
    expect(SCANNER_BACKENDS.trivy.parseReport("{}")).toEqual({ ok: true, vulnerabilities: [] });
  });

  it("rejects a non-array Results", () => {
    expect(SCANNER_BACKENDS.trivy.parseReport('{"Results":"nope"}')).toEqual({
      ok: false,
      detail: "unexpected trivy report shape: Results is not an array",
    });
  });

  it("maps an unrecognized severity to unknown and preserves the raw string", () => {
    const result = SCANNER_BACKENDS.trivy.parseReport(
      trivyReport([
        {
          VulnerabilityID: "CVE-2026-0003",
          PkgName: "curl",
          InstalledVersion: "8.9.0",
          Severity: "IMPORTANT",
        },
      ]),
    );

    if (!result.ok) throw new Error(`expected a parsed report, got: ${result.detail}`);
    expect(result.vulnerabilities[0]?.severity).toBe("unknown");
    expect(result.vulnerabilities[0]?.rawSeverity).toBe("IMPORTANT");
  });
});

describe("grype report parsing", () => {
  it("normalizes a realistic report and omits fixedVersion when no fix exists", () => {
    const result = SCANNER_BACKENDS.grype.parseReport(
      grypeReport([
        {
          vulnerability: {
            id: "CVE-2026-0001",
            severity: "High",
            dataSource: "https://nvd.nist.gov/vuln/detail/CVE-2026-0001",
            fix: { versions: ["3.3.2"], state: "fixed" },
          },
          artifact: { name: "openssl", version: "3.3.1" },
        },
        {
          vulnerability: {
            id: "CVE-2026-0002",
            severity: "Negligible",
            fix: { versions: [], state: "not-fixed" },
          },
          artifact: { name: "zlib", version: "1.3" },
        },
      ]),
    );

    if (!result.ok) throw new Error(`expected a parsed report, got: ${result.detail}`);
    expect(result.vulnerabilities[0]).toEqual({
      id: "CVE-2026-0001",
      severity: "high",
      rawSeverity: "High",
      packageName: "openssl",
      installedVersion: "3.3.1",
      fixedVersion: "3.3.2",
      reference: "https://nvd.nist.gov/vuln/detail/CVE-2026-0001",
    });
    expect(result.vulnerabilities[1]).toEqual({
      id: "CVE-2026-0002",
      severity: "negligible",
      rawSeverity: "Negligible",
      packageName: "zlib",
      installedVersion: "1.3",
    });
    expect(Object.keys(result.vulnerabilities[1] ?? {})).not.toContain("fixedVersion");
  });

  it("rejects empty output", () => {
    const result = SCANNER_BACKENDS.grype.parseReport("");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.detail).toBe("grype produced no report output");
  });

  it("accepts a report with no matches key", () => {
    expect(SCANNER_BACKENDS.grype.parseReport("{}")).toEqual({ ok: true, vulnerabilities: [] });
  });

  it("rejects a non-array matches", () => {
    expect(SCANNER_BACKENDS.grype.parseReport('{"matches":"nope"}')).toEqual({
      ok: false,
      detail: "unexpected grype report shape: matches is not an array",
    });
  });

  it("maps an unrecognized severity to unknown and preserves the raw string", () => {
    const result = SCANNER_BACKENDS.grype.parseReport(
      grypeReport([
        {
          vulnerability: { id: "CVE-2026-0003", severity: "Important" },
          artifact: { name: "curl", version: "8.9.0" },
        },
      ]),
    );

    if (!result.ok) throw new Error(`expected a parsed report, got: ${result.detail}`);
    expect(result.vulnerabilities[0]?.severity).toBe("unknown");
    expect(result.vulnerabilities[0]?.rawSeverity).toBe("Important");
  });
});

describe("retention cap", () => {
  it("caps the retained list but never the counts the gate reads", async () => {
    const entries = Array.from({ length: 250 }, (_unused, index) => ({
      VulnerabilityID: `CVE-2026-${String(index).padStart(4, "0")}`,
      PkgName: `pkg-${String(index).padStart(4, "0")}`,
      InstalledVersion: "1.0.0",
      Severity: "HIGH",
    }));

    const report = await runSecurityScan(
      [{ service: "plex", image: "lscr.io/linuxserver/plex:1.41.3" }],
      [],
      SCOPE,
      settings(),
      createDependencies({
        runScanner: vi.fn(async () => ({
          code: 0,
          stdout: trivyReport(entries),
          stderr: "",
          success: true,
        })),
      }),
    );

    const plex = scannedOnly(report, "plex");
    expect(plex.vulnerabilities).toHaveLength(200);
    expect(plex.truncated).toBe(true);
    expect(plex.counts.high).toBe(250);
    expect(report.summary.high).toBe(250);
    expect(buildScanSummary(report.images).high).toBe(250);
    expect(report.notes).toContain("plex: 200 of 250 findings shown; counts above are complete");
  });
});

describe("evaluateScanGate", () => {
  it("blocks on a finding at or above the threshold", () => {
    const gate = evaluateScanGate([scannedImage("plex", [vulnerability()])], "high");
    expect(gate.status).toBe("blocked");
    expect(gate.blocking).toBe(true);
    expect(gate.blockedBy[0]).toBe("plex: CVE-2026-0001 (high) in openssl@3.3.1");
  });

  it("passes when every finding sits below the threshold", () => {
    const gate = evaluateScanGate(
      [scannedImage("plex", [vulnerability({ severity: "medium", rawSeverity: "MEDIUM" })])],
      "high",
    );
    expect(gate.status).toBe("passed");
    expect(gate.blockedBy).toEqual([]);
  });

  it("never blocks when the threshold is none", () => {
    const gate = evaluateScanGate(
      [scannedImage("plex", [vulnerability({ severity: "critical", rawSeverity: "CRITICAL" })])],
      "none",
    );
    expect(gate.status).toBe("passed");
    expect(gate.blocking).toBe(false);
  });

  it("treats a scan that did not complete as inconclusive, not a pass", () => {
    const failed: ImageScan = {
      status: "failed",
      service: "plex",
      image: "plex:latest",
      reason: "timeout",
      detail: "scanner exceeded 180000ms for this image",
    };
    const gate = evaluateScanGate([failed], "critical");
    expect(gate.status).toBe("inconclusive");
    expect(gate.blocking).toBe(true);
    expect(gate.blockedBy[0]).toBe("plex: scan did not complete (timeout)");
  });
});

describe("resolveScanSettings failOn", () => {
  const CWD = "/srv/rfmedia-apps";

  it("accepts a configured threshold", () => {
    expect(resolveScanSettings({}, { failOn: "critical" }, CWD).failOn).toBe("critical");
  });

  it("refuses a non-canonical configured spelling instead of failing the gate open", () => {
    // rfapps.config.yaml is not schema-validated, so failOn can be any string at
    // runtime; "HIGH" would make SCAN_SEVERITY_RANK[failOn] undefined and pass
    // the gate on a critical CVE.
    expect(() => resolveScanSettings({}, { failOn: "HIGH" } as unknown as ScanConfig, CWD)).toThrow(
      InvalidArgumentError,
    );
  });

  it("lets the CLI flag win over config", () => {
    expect(resolveScanSettings({ scanFailOn: "high" }, { failOn: "low" }, CWD).failOn).toBe("high");
  });

  it("defaults to none when config supplies nothing", () => {
    expect(resolveScanSettings({}, undefined, CWD).failOn).toBe("none");
  });
});

describe("suppressions", () => {
  const TWO_FINDINGS = trivyReport([
    { VulnerabilityID: "CVE-1", PkgName: "openssl", InstalledVersion: "3.3.1", Severity: "HIGH" },
    { VulnerabilityID: "CVE-2", PkgName: "zlib", InstalledVersion: "1.3", Severity: "LOW" },
  ]);

  async function scanPlex(overrides: Partial<ResolvedScanSettings>) {
    return runSecurityScan(
      [{ service: "plex", image: "plex:1.41.3" }],
      [],
      SCOPE,
      settings(overrides),
      createDependencies({
        runScanner: vi.fn(async () => ({
          code: 0,
          stdout: TWO_FINDINGS,
          stderr: "",
          success: true,
        })),
      }),
    );
  }

  it("removes an id-scoped suppression from the findings and the counts", async () => {
    const report = await scanPlex({ ignore: [{ id: "CVE-1", reason: "fix pending upstream" }] });

    const plex = scannedOnly(report, "plex");
    expect(plex.vulnerabilities.map((entry) => entry.id)).toEqual(["CVE-2"]);
    expect(plex.suppressed).toBe(1);
    expect(plex.counts.high).toBe(0);
    expect(report.summary.suppressed).toBe(1);
  });

  it("ignores a suppression scoped to a different service", async () => {
    const report = await scanPlex({
      ignore: [{ id: "CVE-1", service: "sonarr", reason: "fix pending upstream" }],
    });

    const plex = scannedOnly(report, "plex");
    expect(plex.vulnerabilities.map((entry) => entry.id)).toEqual(["CVE-1", "CVE-2"]);
    expect(plex.suppressed).toBe(0);
  });

  it("suppresses everything on a service with a wildcard id", async () => {
    const report = await scanPlex({
      ignore: [{ id: "*", service: "plex", reason: "image is quarantined for migration" }],
    });

    const plex = scannedOnly(report, "plex");
    expect(plex.vulnerabilities).toEqual([]);
    expect(plex.suppressed).toBe(2);
  });

  it("stops applying an expired suppression and says so in the notes", async () => {
    const report = await scanPlex({
      ignore: [{ id: "CVE-1", reason: "fix pending upstream", until: "2026-06-30" }],
    });

    const plex = scannedOnly(report, "plex");
    expect(plex.vulnerabilities.map((entry) => entry.id)).toEqual(["CVE-1", "CVE-2"]);
    expect(plex.suppressed).toBe(0);
    expect(report.notes).toContain(
      "suppression for CVE-1 expired on 2026-06-30 and is no longer applied",
    );
  });
});

describe("resolveScanTargets", () => {
  const CONFIG = {
    services: {
      lidarr: { build: {} },
      bare: {},
      sonarr: { image: "lscr.io/linuxserver/arr:latest" },
      radarr: { image: "lscr.io/linuxserver/arr:latest" },
      plex: { image: "lscr.io/linuxserver/plex:1.41.3" },
    },
  };

  it("classifies build-only, image-less, and duplicate services", () => {
    const { targets, skipped } = resolveScanTargets(CONFIG, [], 64);

    expect(targets).toEqual([
      { service: "plex", image: "lscr.io/linuxserver/plex:1.41.3" },
      { service: "radarr", image: "lscr.io/linuxserver/arr:latest" },
    ]);
    expect(skipped).toEqual([
      { status: "skipped", service: "bare", image: "", reason: "no-image" },
      { status: "skipped", service: "lidarr", image: "", reason: "build-only" },
      {
        status: "skipped",
        service: "sonarr",
        image: "lscr.io/linuxserver/arr:latest",
        reason: "duplicate-image",
        scannedBy: "radarr",
      },
    ]);
  });

  it("skips past the target cap instead of silently scanning more", () => {
    const { targets, skipped } = resolveScanTargets(CONFIG, [], 1);

    expect(targets).toEqual([{ service: "plex", image: "lscr.io/linuxserver/plex:1.41.3" }]);
    expect(skipped).toContainEqual({
      status: "skipped",
      service: "radarr",
      image: "lscr.io/linuxserver/arr:latest",
      reason: "target-cap",
    });
  });
});

describe("degradation", () => {
  const PLEX: ScanTarget = { service: "plex", image: "plex:1.41.3" };
  const TARGETS: readonly ScanTarget[] = [PLEX, { service: "sonarr", image: "sonarr:4.0.0" }];

  it("fails every target without spawning the scanner when the binary is missing", async () => {
    const installHint =
      "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/";
    const dependencies = createDependencies({
      probeScanner: vi.fn(async () => ({ available: false, error: installHint })),
    });

    const report = await runSecurityScan(TARGETS, [], SCOPE, settings(), dependencies);

    expect(report.scanner.available).toBe(false);
    expect(dependencies.runScanner).toHaveBeenCalledTimes(0);
    for (const image of report.images) {
      expect(image).toMatchObject({
        status: "failed",
        reason: "scanner-unavailable",
        detail: installHint,
      });
    }
  });

  it("classifies the timeout sentinel", async () => {
    const report = await runSecurityScan(
      [PLEX],
      [],
      SCOPE,
      settings(),
      createDependencies({
        runScanner: vi.fn(async () => ({
          code: 1,
          stdout: "",
          stderr: "Command timed out",
          success: false,
        })),
      }),
    );

    expect(report.images[0]).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("classifies the capture-limit sentinel", async () => {
    const report = await runSecurityScan(
      [PLEX],
      [],
      SCOPE,
      settings(),
      createDependencies({
        runScanner: vi.fn(async () => ({
          code: 1,
          stdout: "",
          stderr: "Command output exceeded capture limit",
          success: false,
        })),
      }),
    );

    expect(report.images[0]).toMatchObject({ status: "failed", reason: "output-limit" });
  });

  it("isolates one failing target from the rest of the run", async () => {
    const report = await runSecurityScan(
      TARGETS,
      [],
      SCOPE,
      settings(),
      createDependencies({
        runScanner: vi.fn(async (_backend, args) =>
          args.includes("sonarr:4.0.0")
            ? {
                code: 1,
                stdout: "",
                stderr: "FATAL unable to fetch vulnerability DB\n",
                success: false,
              }
            : { code: 0, stdout: "{}", stderr: "", success: true },
        ),
      }),
    );

    expect(scannedOnly(report, "plex").vulnerabilities).toEqual([]);
    expect(report.images.find((image) => image.service === "sonarr")).toMatchObject({
      status: "failed",
      reason: "scanner-error",
      detail: "FATAL unable to fetch vulnerability DB",
    });
    expect(report.summary.targetsScanned).toBe(1);
    expect(report.summary.targetsFailed).toBe(1);
  });
});
