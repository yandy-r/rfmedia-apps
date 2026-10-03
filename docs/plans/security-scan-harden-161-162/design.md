# Design: rfapps-cli #161 (Vulnerability Scanning) + #162 (Security Hardening Automation)

**Status:** authoritative. Implementation must follow this document; deviations are defects.
**Base:** `minimal-surface` proposal, with the specific grafts the judges called out.
**Repo root:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps` (worktree `.claude/worktrees/rfmedia-apps-feat-security-scan-harden`). All paths below are repo-relative unless stated; `P/` abbreviates `packages/rfapps-cli/`.

## 0. Decisions where the judges disagreed (one line each)

1. **No standalone `rfapps scan` command.** #161 says "integrate into plan/deploy safety workflow" at Medium 3–5 files; a new command adds 9 completion sites, a README section, and an MCP decision for zero new capability.
2. **Harden gets its own rule catalog; `LINT_RULES` is not touched.** Appending to it breaks the live assertion `expect(LINT_RULES).toHaveLength(8)` at `P/src/lib/lint.spec.ts:42` and changes shipped `rfapps lint` output for ~47 services — behaviour change outside both issues.
3. **Harden rule ids are namespaced `harden-*`.** Reusing bare ids would add a fourth collision on top of the existing `cap-drop-missing` clash between `LintRuleId` and `AuditRuleId`.
4. **Because ids are namespaced, harden cannot reuse `lint.ignore`** (its validator rejects unknown ids at `P/src/lib/lint.ts:194-212`), so a separate optional `harden:` config section is required — the two grafts were mutually exclusive.
5. **Scan targets come from `getComposeConfig`, never from `DeploymentPlan`.** This gives build-only exclusion for free (`ComposeServiceConfig.build` already exists, `P/src/lib/docker.ts:1080-1084`), needs no `ImageDiff.buildOnly` field, and therefore needs no `imageDiffBaseShape` MCP mirror.
6. **The scan report attaches to the plan action's _output envelope_, never to the saved plan.** `savePlan` JSON-stringifies the whole plan (`P/src/lib/plan-storage.ts`), so an embedded CVE verdict would decay and `rfapps apply <path>` days later would re-assert it as authoritative.
7. **`--scan-fail-on` hard default is `none` (advisory).** Asking to scan is not asking to gate; a `critical` default would block nearly every deploy of upstream `lscr.io/linuxserver/*` images.
8. **The gate is fail-closed whenever `--scan-fail-on` ≠ `none`**: missing scanner, timeout, capture overflow, and unparsable report all resolve to `inconclusive`, which blocks. A scan that "passes" because trivy is absent is the hidden fallback repo policy forbids.
9. **No unified-diff module.** Instead, canonical serialization plus an explicit `--allow-reformat` acknowledgement (see §4.6). Verified empirically: with `{ lineWidth: 0, flowCollectionPadding: false }` the round-trip delta on this repo's `compose.yml` is **exactly one hunk** (a prettier-wrapped flow sequence in `authentik-server.healthcheck.test`), so a hard refusal would ship `--apply` dead while a hand-rolled LCS diff is machinery the package does not have.
10. **No MCP schema changes for either issue.** Verified below (§5.2).
11. **`forEachBounded` is not extracted** from `P/src/lib/plan-generator.ts`; `lib/security-scan.ts` gets a private 12-line worker pool. Extraction would edit a 979-line hot file with its own spec for zero behaviour gain.
12. **A `resolveScanExitCode` / `setScanExitCode` pair is added** to `P/src/lib/exit-codes.ts` despite the base proposal omitting it — every threshold-bearing feature in the repo has one (`resolveLintExitCode`, `resolveReconcileExitCode`, `resolveStateRebuildExitCode`).

---

## 1. Scope & non-goals

### 1.1 #161 — Vulnerability scanning in plan/deploy

**In scope**

- New `P/src/types/security-scan.ts`, new `P/src/lib/security-scan.ts` (the two files the issue names).
- Pluggable scanner backends: `trivy` and `grype`, behind a `ScannerBackend` record closed with `as const satisfies Record<ScannerId, ScannerBackend>`.
- Pre-apply reporting in `plan` and pre-mutation gating in `deploy`, both opt-in.
- Severity thresholds with an opt-in fail gate.
- New optional `scan:` config section with time-boxed, reasoned suppressions.
- `checkExternalTool` in `packages/rf-common/src/env-tools.ts`.

**Deferred, with reason**

| Deferred                                 | Reason                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Standalone `rfapps scan` command         | Not asked for; `plan --scan` covers the read-only case. `lib/security-scan.ts` has zero CLI knowledge, so a command is one registrar + one action later.                                                                                               |
| Digest pinning of scan targets           | The scan runs pre-pull by design (the gate must precede mutation). Scanning a _local_ digest would describe the old image. We scan the reference compose resolves and document the mutable-tag gap; pin digests in `compose.yml` for a hard guarantee. |
| SBOM/SARIF export, on-disk finding cache | Cache invalidation must track the scanner's vulnerability-DB version; a stale "clean" verdict is a worse trust liability than a slow scan. Separate issue.                                                                                             |
| `docker scout`, `snyk` backends          | The registry makes each a single new entry; no consumer today.                                                                                                                                                                                         |
| MCP exposure of scan arguments           | Keeping `scan` out of `planInputSchema`/`deployInputSchema` is what makes the nested payload structurally unreachable and the output mirror unnecessary.                                                                                               |
| `RFAPPS_SCAN_*` env overrides            | Six keys nobody sets per-invocation; `applyCliOverrides` carries only four knobs by design.                                                                                                                                                            |

### 1.2 #162 — `rfapps harden`

**In scope**

- Exactly the four files the issue names: `P/src/commands/harden.ts`, `P/src/actions/harden.ts`, `P/src/lib/hardening.ts`, `P/src/types/hardening.ts`.
- Nine rules covering all six named categories (capabilities, user, filesystem mode, logging, limits, health checks).
- Propose mode as the default (writes nothing), `--out <path>` override fragment, `--apply` in-place edit.
- New optional `harden:` config section.

**Deferred, with reason**

| Deferred                                                | Reason                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified-diff / `git apply`-able patch                   | See decision 9. The text output already names every key and value that would be written, and `--out` renders the literal YAML.                                                                                                                                |
| Synthesised `healthcheck.test`, `memory`, `cpus` values | A wrong probe marks a healthy service unhealthy; a wrong ceiling OOM-kills it. These three rules are **advisory** — detection plus guidance, no fabricated value. This is a deliberate scope call, not an omission, and must be stated in the PR description. |
| Automated removal of `privileged: true`                 | Requires enumerating the `cap_add`/`devices`/`security_opt` the workload actually needs. `rfapps lint` and `rfapps audit` already flag it at `error`/`critical`; harden adds nothing safe.                                                                    |
| `--fail-on` on harden                                   | `rfapps lint --fail-on` already gates this exact subject matter; a second threshold on the same findings is two places to disagree. Refusing an unsafe edit is correct behaviour, not an operational failure.                                                 |
| MCP tool for `harden`                                   | Neither `lint` nor `audit` is MCP-surfaced, and a compose-file mutator reachable without the confirmation prompt is a materially different risk conversation.                                                                                                 |
| User-defined rules / rule presets                       | `--rule`, `harden.ignore`, and `--include-review` express every selection anyone has asked for.                                                                                                                                                               |

---

## 2. Shared foundations

**Rejected: any shared severity model, finding type, gate helper, suppression generic, or renderer between the two features.** They arrived in one bucket because both say "security"; their mechanics are unrelated:

- #161 speaks the CVE scale (`critical|high|medium|low|negligible|unknown`) because that is what trivy and grype emit. #162 reuses the compose vocabulary (`error|warn|info`) plus an orthogonal _risk_ axis (`safe|review|advisory`). A shared union would force `unknown` into the compose domain and `review` into the CVE domain.
- #162 has no gate at all, so there is no threshold logic to extract.
- The repo already carries `LintSeverity`, `AuditSeverity`, `ConflictSeverity`, and `DoctorSeverity` as independent unions with hand-rolled rank maps. Extracting a generic `createSeverityGate` while leaving `LINT_SEVERITY_RANK` (`P/src/lib/exit-codes.ts:64`) and `SEVERITY_RANK` (`P/src/lib/security-audit.ts:23`) in place would ship **three** coexisting patterns — strictly worse than two.

**Shared by extraction — exactly one item, justified:**

`packages/rf-common/src/env-tools.ts` gains a generic PATH probe next to `checkDotenvx` (`:111`) and `checkOp` (`:143`), reusing the already-private `commandExists` (`:57`) and `getCommandVersion` (`:73`):

```ts
/**
 * Probe an arbitrary external tool on PATH.
 *
 * @param command - executable name
 * @param versionFlag - flag that prints a version (e.g. "--version", "version")
 * @param installHint - operator-facing install instruction, returned verbatim as `error`
 */
export async function checkExternalTool(
  command: string,
  versionFlag: string,
  installHint: string,
): Promise<ToolCheckResult> {
  if (!(await commandExists(command))) {
    return { available: false, error: installHint };
  }
  return { available: true, version: await getCommandVersion(command, versionFlag) };
}
```

Exported from `packages/rf-common/src/index.ts:117` (add to the existing `export { checkDotenvx, checkOp, envFileExists }` line). Only #161 consumes it; writing a second `which` spawn inside rfapps-cli would be the third copy of a tested primitive.

**Shared by reuse of existing exports (no new code):** `execWithEnv` (`P/src/lib/env-tools.ts:303`), `getComposeConfig` (`P/src/lib/docker.ts:1096`), `filterToolOutput` (`P/src/lib/docker.ts:219`), `resolveServicesWithInteractive`, `applyCliOverrides`, `isValidProfile`, `getEnvToolExecConfig`, `formatOutput`, `formatError`/`outputFormattedError`, `confirm`, `isMachineFormat`, `ExitCode`/`setExitCode`, and for #162 the `yaml` CST helpers plus the exported predicates `hasWritableBindMounts` (`P/src/lib/lint-context.ts:61`), `hasCapAdd` (`:78`), `hasDevices` (`:85`), `runsAsRoot` (`:92`).

**Sequencing:** the two features are independently mergeable in either order. Their only file-level contacts are append-only registries (`cli.ts`, the two barrels, `completion.ts`, `config.ts`, `exit-codes.ts`, docs).

---

## 3. #161 — Vulnerability scanning

### 3.1 `P/src/types/security-scan.ts` (new, ~150 lines)

Import-free except for `ToolCheckResult`, so `P/src/types/config.ts` can import from it without a cycle.

```ts
import type { ToolCheckResult } from "@rfmedia/common";

/** Machine contract version for image vulnerability scan payloads. */
export const SCAN_SCHEMA_VERSION = "security-scan.v1" as const;

/** Registered scanner backends. Adding one requires a matching SCANNER_BACKENDS entry. */
export type ScannerId = "trivy" | "grype";

/**
 * Vendor-normalized CVE severity. Ordered by SCAN_SEVERITY_RANK.
 * `unknown` is the sink for any severity string a scanner emits that we do not recognise.
 */
export type ScanSeverity = "critical" | "high" | "medium" | "low" | "negligible" | "unknown";

/** Gate threshold. `none` means report-only. */
export type ScanFailOn = ScanSeverity | "none";

/** One image to hand to a scanner. */
export interface ScanTarget {
  /** Compose service that references the image. */
  readonly service: string;
  /** Image reference exactly as `docker compose config` resolved it. */
  readonly image: string;
}

export interface ScanVulnerability {
  /** Advisory identifier (CVE-…, GHSA-…, ALAS-…). */
  readonly id: string;
  readonly severity: ScanSeverity;
  /** Severity string exactly as the scanner emitted it, for auditability. */
  readonly rawSeverity: string;
  readonly packageName: string;
  readonly installedVersion: string;
  /** First fixed version, when the scanner reported one. */
  readonly fixedVersion?: string;
  readonly reference?: string;
}

export interface ScanSeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly negligible: number;
  readonly unknown: number;
}

export type ScanSkipReason =
  /** Service declares `build:`; there is no registry artifact to scan. */
  | "build-only"
  /** Service declares neither `image` nor `build`. */
  | "no-image"
  /** Another service already scanned this exact image reference. */
  | "duplicate-image"
  /** Target count exceeded scan.maxTargets. */
  | "target-cap";

export type ScanFailureCode =
  /** No scanner binary on PATH. */
  | "scanner-unavailable"
  /** execWithEnv reported "Command timed out". */
  | "timeout"
  /** execWithEnv reported "Command output exceeded capture limit". */
  | "output-limit"
  /** Scanner exited non-zero for a reason other than the two above. */
  | "scanner-error"
  /** stdout was not the JSON shape the backend expects. */
  | "invalid-report";

/** Per-target outcome. Discriminated on `status`. */
export type ImageScan =
  | {
      readonly status: "scanned";
      readonly service: string;
      readonly image: string;
      readonly counts: ScanSeverityCounts;
      /** Findings that survived suppression, highest severity first, capped. */
      readonly vulnerabilities: readonly ScanVulnerability[];
      /** Suppressed count for this target; `counts` excludes suppressed entries. */
      readonly suppressed: number;
      /** True when `vulnerabilities` was capped; `counts` still reflects every surviving entry. */
      readonly truncated: boolean;
      readonly durationMs: number;
    }
  | {
      readonly status: "skipped";
      readonly service: string;
      /** Empty string when the service declares no image. */
      readonly image: string;
      readonly reason: ScanSkipReason;
      /** Service that owns the scan when reason is "duplicate-image". */
      readonly scannedBy?: string;
    }
  | {
      readonly status: "failed";
      readonly service: string;
      readonly image: string;
      readonly reason: ScanFailureCode;
      /** Bounded operator-actionable detail: install hint, or last stderr line (<=400 chars). */
      readonly detail: string;
    };

/**
 * Gate verdict.
 * `inconclusive` blocks exactly like `blocked` whenever failOn !== "none".
 */
export type ScanGateStatus = "passed" | "blocked" | "inconclusive";

export interface ScanGate {
  readonly failOn: ScanFailOn;
  readonly status: ScanGateStatus;
  /** True when the caller must refuse to proceed. Single authoritative answer. */
  readonly blocking: boolean;
  /** "plex: CVE-2024-45490 (critical) in expat@2.5.0" / "sonarr: scan failed (timeout)". */
  readonly blockedBy: readonly string[];
}

export interface ScanSummary extends ScanSeverityCounts {
  readonly total: number;
  readonly suppressed: number;
  readonly targetsScanned: number;
  readonly targetsSkipped: number;
  readonly targetsFailed: number;
}

export interface ScanScope {
  readonly services: readonly string[];
  readonly profiles: readonly string[];
  readonly composePath: string;
}

export interface ScannerIdentity {
  readonly id: ScannerId;
  readonly binary: string;
  readonly version?: string;
  readonly available: boolean;
}

export interface ScanReport {
  readonly schemaVersion: typeof SCAN_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly scanner: ScannerIdentity;
  readonly scope: ScanScope;
  readonly gate: ScanGate;
  readonly summary: ScanSummary;
  readonly images: readonly ImageScan[];
  /** Operator-visible caveats: expired suppressions, truncation, target cap. */
  readonly notes: readonly string[];
}

/** Time-boxed, reasoned CVE acceptance. */
export interface ScanSuppression {
  /** Advisory id, or "*" for every advisory on the matched target. */
  readonly id: string;
  /** Limit to one compose service; omit for all. */
  readonly service?: string;
  /** Required. An undocumented suppression is a fallback that hides a real issue. */
  readonly reason: string;
  /** ISO-8601 date. Absent = never expires. An expired entry does NOT suppress. */
  readonly until?: string;
}

/** `scan:` section of rfapps.config.yaml. */
export interface ScanConfig {
  readonly scanner?: ScannerId;
  readonly failOn?: ScanFailOn;
  readonly ignore?: readonly ScanSuppression[];
  /** Per-image scanner timeout in ms. */
  readonly timeoutMs?: number;
  /** Maximum distinct images scanned per invocation. */
  readonly maxTargets?: number;
  /** Concurrent scanner processes. */
  readonly concurrency?: number;
}

/** Fully resolved settings (CLI ?? config ?? hard default already applied). */
export interface ResolvedScanSettings {
  readonly scanner: ScannerId;
  readonly failOn: ScanFailOn;
  readonly ignore: readonly ScanSuppression[];
  readonly timeoutMs: number;
  readonly maxTargets: number;
  readonly concurrency: number;
  readonly cwd: string;
}

/** Scan-local view of a resolved compose service. */
export interface ScanComposeService {
  readonly image?: string;
  readonly build?: unknown;
}

export interface ScanComposeConfig {
  readonly services: Readonly<Record<string, ScanComposeService>>;
}

/** Result of one scanner stdout parse. Backends never throw. */
export type ScannerParseResult =
  | { readonly ok: true; readonly vulnerabilities: readonly ScanVulnerability[] }
  | { readonly ok: false; readonly detail: string };

/**
 * A scanner plugin. Both methods are pure and synchronous: the runner owns the
 * process, the timeout, the capture caps, and the bounded fan-out.
 */
export interface ScannerBackend {
  readonly id: ScannerId;
  /** Executable looked up on PATH. */
  readonly binary: string;
  /** Argument that prints a version ("--version" for trivy, "version" for grype). */
  readonly versionFlag: string;
  /** Returned verbatim as ImageScan.detail when the binary is absent. */
  readonly installHint: string;
  buildArgs(target: ScanTarget, settings: ResolvedScanSettings): readonly string[];
  parseReport(stdout: string): ScannerParseResult;
}

/** Injected boundary. The default implementation is the only I/O in #161. */
export interface SecurityScanDependencies {
  readonly probeScanner: (backend: ScannerBackend) => Promise<ToolCheckResult>;
  readonly runScanner: (
    backend: ScannerBackend,
    args: readonly string[],
    settings: ResolvedScanSettings,
  ) => Promise<{ code: number; stdout: string; stderr: string; success: boolean }>;
  readonly now: () => Date;
  readonly elapsedMs: () => number;
}
```

### 3.2 `P/src/lib/security-scan.ts` (new, ~420 lines)

Pure core + one injected exec boundary, split like `P/src/lib/security-audit.ts` + `P/src/lib/backup-docker.ts`.

```ts
import { createHash } from "node:crypto";
import { checkExternalTool } from "@rfmedia/common";
import { filterToolOutput } from "./docker.js";
import { execWithEnv } from "./env-tools.js";
import { InvalidArgumentError } from "./errors.js";
import { SCAN_SCHEMA_VERSION } from "../types/security-scan.js";
import type {} from /* … all of §3.1 … */ "../types/security-scan.js";

export const SCAN_SEVERITY_RANK: Readonly<Record<ScanSeverity, number>> = {
  unknown: 0,
  negligible: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

const VALID_FAIL_ON: readonly ScanFailOn[] = ["none", "unknown", "negligible", "low", "medium", "high", "critical"];

export const SCANNER_IDS: readonly ScannerId[] = ["trivy", "grype"];

/** Scanner reports are unbounded external input; cap capture and retention. */
const MAX_SCAN_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_STDERR_BYTES = 256 * 1024;
const MAX_RETAINED_PER_TARGET = 200;
const MAX_DETAIL_CHARS = 400;

const DEFAULT_SCANNER: ScannerId = "trivy";
const DEFAULT_FAIL_ON: ScanFailOn = "none";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TARGETS = 64;
const DEFAULT_CONCURRENCY = 2;
const PROBE_TIMEOUT_MS = 15_000;
```

**Exported surface:**

```ts
export const SCANNER_BACKENDS = { trivy: trivyBackend, grype: grypeBackend }
  as const satisfies Record<ScannerId, ScannerBackend>;

/** @throws {InvalidArgumentError} on an unknown id. */
export function resolveScannerBackend(id: string): ScannerBackend;

/** Returns undefined when the flag was absent, so config can win. @throws {InvalidArgumentError} */
export function parseScanFailOn(value: string | undefined): ScanFailOn | undefined;

/** CLI ?? config ?? hard default. @throws {InvalidArgumentError} */
export function resolveScanSettings(
  raw: { readonly scanFailOn?: string; readonly scanner?: string },
  configured: ScanConfig | undefined,
  cwd: string,
): ResolvedScanSettings;

/** @throws {InvalidArgumentError} on a blank reason or unparsable `until`. */
export function normalizeScanSuppressions(
  entries: readonly ScanSuppression[],
): readonly ScanSuppression[];

/** Resolved compose config -> targets, with build-only / no-image / cap / dedupe classification. */
export function resolveScanTargets(
  config: ScanComposeConfig,
  services: readonly string[],
  maxTargets: number,
): { readonly targets: readonly ScanTarget[]; readonly skipped: readonly ImageScan[] };

export function buildScanSummary(images: readonly ImageScan[]): ScanSummary;

/** The single authoritative blocking decision. */
export function evaluateScanGate(
  images: readonly ImageScan[],
  failOn: ScanFailOn,
): ScanGate;

/** Never throws. Every failure becomes an ImageScan arm. */
export function runSecurityScan(
  targets: readonly ScanTarget[],
  preskipped: readonly ImageScan[],
  scope: ScanScope,
  settings: ResolvedScanSettings,
  dependencies?: SecurityScanDependencies,
): Promise<ScanReport>;

/** Pure renderer, `string[]`, printed by the host action. */
export function formatScanText(report: ScanReport): string[];
```

Private default dependencies:

```ts
const DEFAULT_DEPENDENCIES: SecurityScanDependencies = {
  probeScanner: (backend) => checkExternalTool(backend.binary, backend.versionFlag, backend.installHint),
  runScanner: (backend, args, settings) =>
    execWithEnv(backend.binary, [...args], {
      // A vulnerability scanner is never handed decrypted application secrets,
      // and `none` removes the dotenvx/op banner JSON-corruption hazard.
      tool: "none",
      cwd: settings.cwd,
      timeout: settings.timeoutMs,
      maxStdoutBytes: MAX_SCAN_STDOUT_BYTES,
      maxStderrBytes: MAX_SCAN_STDERR_BYTES,
    }),
  now: () => new Date(),
  elapsedMs: () => performance.now(),
};
```

#### `resolveScanTargets` classification order

For each service name in `services` (or every key when `services` is empty), sorted:

1. `build !== undefined` → `{ status: "skipped", reason: "build-only" }`. **Required**: `compose.yml:1117` gives `lidarr` a `build:` context; an unbuilt local image makes trivy error, which the gate would turn into `inconclusive` and block a deploy for a non-vulnerability reason.
2. `image === undefined || image.trim() === ""` → `{ status: "skipped", reason: "no-image", image: "" }`.
3. Image already claimed by an earlier service → `{ status: "skipped", reason: "duplicate-image", scannedBy }`. Distinct-image count is what is capped and scanned; the per-service provenance entry stays in the report so a 47-service compose sharing `lscr.io/linuxserver/*` is traceable.
4. Distinct-image count > `maxTargets` → `{ status: "skipped", reason: "target-cap" }` and a `notes` line.
5. Otherwise a `ScanTarget`.

#### `runSecurityScan` control flow

1. `targets.length === 0` → report with `scanner.available: false` only if no probe ran; emit `gate = evaluateScanGate(preskipped, failOn)` (which is `passed`, since there are no scanned or failed targets) and return. Nothing is spawned.
2. One probe: `dependencies.probeScanner(backend)`. On `available === false`, **every** target becomes `{ status: "failed", reason: "scanner-unavailable", detail: probe.error ?? backend.installHint }`; no scan is attempted. This is one probe, not N.
3. Bounded fan-out over distinct targets with a private 12-line worker pool at `settings.concurrency` (default 2 — scanners are memory- and disk-hungry).
4. Per target: `buildArgs` → `runScanner` → classify, in this exact order:
   - `stderr === "Command timed out"` → `timeout`
   - `stderr === "Command output exceeded capture limit"` → `output-limit`
   - `success === false` → `scanner-error`, `detail` = last non-blank stderr line truncated to `MAX_DETAIL_CHARS`
   - `parseReport(...).ok === false` → `invalid-report`, `detail` = the parse detail
   - otherwise `scanned`

   The two sentinel strings are matched **exactly**; they are the literals `execWithEnv` produces at `P/src/lib/env-tools.ts:365-370` and nothing else distinguishes truncation from a scanner crash.

5. Suppression: apply `normalizeScanSuppressions` output. An entry whose `until` is in the past does **not** suppress and pushes `suppression for <id>[ (<service>)] expired on <until> and is no longer applied` into `notes`.
6. Sort surviving findings by severity desc → `packageName` asc → `id` asc (a total order, so JSON is byte-deterministic apart from `timestamp`/`durationMs`). Compute `counts` from **every** surviving finding, then cap the retained list at `MAX_RETAINED_PER_TARGET` and set `truncated`.
7. `buildScanSummary`, `evaluateScanGate`, assemble.

**`runSecurityScan` never throws and never touches `process.exitCode`.**

#### `evaluateScanGate`

```ts
export function evaluateScanGate(images: readonly ImageScan[], failOn: ScanFailOn): ScanGate {
  if (failOn === "none") {
    return { failOn, status: "passed", blocking: false, blockedBy: [] };
  }
  const threshold = SCAN_SEVERITY_RANK[failOn];
  const blockedBy: string[] = [];
  let breached = false;
  let degraded = false;

  for (const scan of images) {
    if (scan.status === "failed") {
      degraded = true;
      blockedBy.push(`${scan.service}: scan did not complete (${scan.reason})`);
      continue;
    }
    if (scan.status !== "scanned") continue;
    for (const vuln of scan.vulnerabilities) {
      if (SCAN_SEVERITY_RANK[vuln.severity] >= threshold) {
        breached = true;
        blockedBy.push(
          `${scan.service}: ${vuln.id} (${vuln.severity}) in ` + `${vuln.packageName}@${vuln.installedVersion}`,
        );
      }
    }
  }

  if (breached) return { failOn, status: "blocked", blocking: true, blockedBy };
  if (degraded) return { failOn, status: "inconclusive", blocking: true, blockedBy };
  return { failOn, status: "passed", blocking: false, blockedBy: [] };
}
```

A `truncated` target can hide a finding above threshold, so truncation is only ever applied to the _retained list_, never to `counts` — and `counts` is what the summary reports. Threshold evaluation reads the retained list, which is sorted severity-descending, so any above-threshold entry is always retained (200 entries at or above the highest severity present).

### 3.3 Backend implementations

Both live in `security-scan.ts` as module-private consts. Both narrow field-by-field from `unknown` with `typeof` guards — no `any`, no cast to a vendor interface. Both run `filterToolOutput(stdout.split("\n")).join("\n")` before `JSON.parse` (defensive: the scanner is spawned with `tool: "none"`, but the helper is free and the invariant should not depend on that).

**Neither backend is ever passed the scanner's own gate flag** (`trivy --exit-code`, `grype --fail-on`). rfapps owns the threshold, so `success === false` unambiguously means _error_. This deletes the classic findings-vs-error misdiagnosis; there is deliberately no `findingExitCodes` field.

#### trivy

```ts
const trivyBackend: ScannerBackend = {
  id: "trivy",
  binary: "trivy",
  versionFlag: "--version",
  installHint: "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/",
  buildArgs: (target, settings) => [
    "image",
    "--quiet",
    "--no-progress",
    "--scanners",
    "vuln",
    "--format",
    "json",
    "--timeout",
    `${Math.max(1, Math.ceil(settings.timeoutMs / 1000))}s`,
    target.image,
  ],
  parseReport: parseTrivyReport,
};
```

`parseTrivyReport`: top level must be an object; `Results` absent or `[]` → `{ ok: true, vulnerabilities: [] }`; `Results` present but not an array → `{ ok: false, detail: "unexpected trivy report shape: Results is not an array" }`. Per entry read `VulnerabilityID`, `Severity`, `PkgName`, `InstalledVersion`, `FixedVersion`, `PrimaryURL`; skip entries missing `VulnerabilityID`, `PkgName`, or `InstalledVersion`. Severity map (uppercase key): `CRITICAL|HIGH|MEDIUM|LOW|UNKNOWN`; anything else → `unknown`, with the original preserved in `rawSeverity`.

#### grype

```ts
const grypeBackend: ScannerBackend = {
  id: "grype",
  binary: "grype",
  versionFlag: "version",
  installHint: "grype not found in PATH. Install from https://github.com/anchore/grype#installation",
  buildArgs: (target) => [target.image, "-o", "json", "-q"],
  parseReport: parseGrypeReport,
};
```

`parseGrypeReport`: top level object; `matches` absent → `{ ok: true, vulnerabilities: [] }`; present but not an array → `{ ok: false, … }`. Per match read `vulnerability.id`, `vulnerability.severity`, `vulnerability.dataSource`, `vulnerability.fix.versions[0]`, `artifact.name`, `artifact.version`. Severity map (capitalised): `Critical|High|Medium|Low|Negligible|Unknown`; anything else → `unknown`.

grype has no server-side severity filter and we pass none to trivy either, so counts are complete for both.

### 3.4 Availability probing and timeout handling

- Probing goes through `checkExternalTool` (§2), which is a `which` lookup plus a version read. `--scanner trivy` never silently falls back to grype: silent backend substitution changes the finding set without telling the operator, so an explicitly selected-and-absent scanner produces `scanner-unavailable` naming that scanner. There is no `auto` selection in v1 — the config/CLI value is a concrete `ScannerId`.
- Per-image timeout: `settings.timeoutMs` (default 180 000 ms), passed to `execWithEnv`, which SIGTERMs the direct child and resolves `{ code: 1, stderr: "Command timed out", success: false }`. Known limitation, documented in a code comment: `execWithEnv` does not process-group-kill or escalate to SIGKILL; scanners are single-process and short-lived, so this is acceptable (unlike `execDocker`, which cannot run `trivy` because it hardcodes `"docker"` as argv[0]).
- Probe timeout is not configurable; `checkExternalTool` uses `spawn` directly and returns promptly.
- Wall-clock bound: `maxTargets` (64) × distinct images at `concurrency` 2 with a 180 s ceiling. `formatScanText` emits the `Scanner:` identity line **before** the first scan starts so a cold trivy DB does not look like a hang.

### 3.5 Severity model and thresholds

`unknown < negligible < low < medium < high < critical`. `--scan-fail-on <sev>` blocks at or above `<sev>`; `none` never blocks.

Resolution is `CLI ?? config ?? hard default`, hard default `none`. **`--scan-fail-on` and `--scanner` are registered without a Commander default**, because `applyCliOverrides` (`P/src/lib/config.ts:495-531`) carries only `composePath`, `envFile`, `profile`, and `noSidecars`, so a Commander default would make `rawOptions.scanFailOn` always defined and permanently mask `scan.failOn`. Validation lives in the action via `InvalidArgumentError`, never in a Commander `argParser` (which `process.exit(1)`s before `.action()`).

### 3.6 Integration point 1 — `P/src/actions/plan.ts`

- `RawPlanOptions` (`:50-62`) gains `scan?: boolean; scanner?: string; scanFailOn?: string`.
- `PlanOptions` (`:67-83`) gains `scan: boolean`.
- `PlanOutputPayload` (`:87-90`) becomes `{ planPath: string; plan: DeploymentPlan; scan?: ScanReport }`.
- `planResultForOutput` (`:107`) additionally strips `scan` for `table`/`csv`:

```ts
function planResultForOutput(format, payload) {
  const flattens = format === "table" || format === "csv";
  if (!flattens) return payload;
  const { scan: _scan, ...rest } = payload;
  if (rest.plan.intelligence === undefined) return rest;
  const { intelligence: _intelligence, ...plan } = rest.plan;
  return { ...rest, plan };
}
```

- **New block**, inserted between the `plan === undefined` guard (ends `:457`) and `const planPath = await savePlan(...)` (`:459`):

```ts
let scan: ScanReport | undefined;
if (options.scan) {
  const settings = resolveScanSettings(rawOptions, finalConfig.scan, process.cwd());
  const composeConfig = await getComposeConfig(finalConfig.composePath, {
    profiles,
    envFile: finalConfig.envFile,
    envTool,
  });
  if (composeConfig === undefined) {
    const error = new DockerCommandError(
      "config",
      "Failed to resolve compose config for scanning",
      1,
      services.length > 0 ? services : ["all"],
      false,
    );
    outputFormattedError(formatError(error));
    setExitCode(ExitCode.OperationalError);
    return;
  }
  const { targets, skipped } = resolveScanTargets(
    composeConfig as unknown as ScanComposeConfig,
    services,
    settings.maxTargets,
  );
  scan = await runSecurityScan(
    targets,
    skipped,
    {
      services,
      profiles,
      composePath: finalConfig.composePath,
    },
    settings,
  );
}
```

- Machine output at `:463` becomes `planResultForOutput(format, { planPath, plan, ...(scan === undefined ? {} : { scan }) })`.
- Text output: after the existing `To apply this plan` block (`:471-473`), `if (scan !== undefined) for (const line of formatScanText(scan)) console.error(line);`.
- Gate, immediately **before** `if (options.apply)` (`:477`):

```ts
if (scan !== undefined && scan.gate.blocking) {
  setScanExitCode(scan); // ExitCode.OperationalError
  return; // suppresses --apply
}
```

The plan file is still written when the gate blocks — a plan is evidence, not a mutation, and `rfapps apply <path>` remains the explicit operator override.

`--dry-run` short-circuits at `:414-418` before plan generation, so `plan --dry-run --scan` scans nothing. Documented, not special-cased.

**`DeploymentPlan` is not modified. `P/src/types/plan.ts`, `P/src/lib/plan-generator.ts`, `P/src/lib/plan-storage.ts`, and `P/src/actions/apply.ts` are untouched.**

### 3.7 Integration point 2 — `P/src/actions/deploy.ts`

- `RawDeployOptions` (`:88-115`) gains `scan?: boolean; scanner?: string; scanFailOn?: string`.
- `DeployOptions` gains `scan: boolean`.
- `P/src/types/results.ts` `DeployResult` (`:106-122`) gains `scan?: ScanReport;` beside `validation?` / `staged?`.
- `deployResultForOutput` (`:159-166`) adds `scan` to its strip set:

```ts
function deployResultForOutput(format: OutputFormat, result: DeployResult): DeployResult | object {
  const flattens = format === "table" || format === "csv";
  if (!flattens || (result.validation === undefined && result.staged === undefined && result.scan === undefined)) {
    return result;
  }
  const { validation: _v, staged: _s, scan: _sc, ...deployResult } = result;
  return deployResult;
}
```

- New helper beside `validationFailureEntry` (`:116`):

```ts
function scanFailureEntry(status: "blocked" | "inconclusive"): FailedOperation {
  return status === "blocked"
    ? {
        name: "scan",
        code: "VULNERABILITY_THRESHOLD",
        error: "Image vulnerability scan found findings at or above the configured severity",
      }
    : {
        name: "scan",
        code: "SCAN_INCONCLUSIVE",
        error: "Image vulnerability scan could not complete for every target",
      };
}
```

The shape is `FailedOperation = { name, error, code? }` (`P/src/types/results.ts:195-202`) — **not** `{ service, recoverable }`.

- **Run block**, inserted after `const deployExecution = …` (ends `:425`) and before `// Auto-enable forceRecreate` (`:427`):

```ts
if (options.scan) {
  const settings = resolveScanSettings(rawOptions, finalConfig.scan, invocationCwd);
  const composeConfig = await getComposeConfig(deployComposePath, {
    profiles,
    envFile: finalConfig.envFile,
    ...deployExecution,
  });
  if (composeConfig === undefined) {
    const error = new DockerCommandError(
      "config",
      "Failed to resolve compose config for scanning",
      1,
      services.length > 0 ? services : ["all"],
      false,
    );
    outputFormattedError(formatError(error));
    setExitCode(ExitCode.OperationalError);
    return;
  }
  const { targets, skipped } = resolveScanTargets(
    composeConfig as unknown as ScanComposeConfig,
    services,
    settings.maxTargets,
  );
  result.scan = await runSecurityScan(
    targets,
    skipped,
    {
      services,
      profiles,
      composePath: deployComposePath,
    },
    settings,
  );
  if (format === "text" || format === "table") {
    for (const line of formatScanText(result.scan)) logInfo(line);
  }
}
```

- **Dry-run reporting**: inside the existing dry-run branch (`:443-520`), the machine payload gains, next to the existing `validation` spread at `:508-510`:

```ts
...(result.scan === undefined || format === "table" ? {} : { scan: result.scan }),
```

and, when `result.scan?.gate.blocking === true`, a text line `logInfo("would block deploy (--scan-fail-on ${result.scan.gate.failOn})")`. **`deploy --dry-run --scan`exits 0 even when the gate would block** —`--dry-run`means "preview, always succeed" everywhere else in this CLI, and breaking that makes`--dry-run`unusable in pipelines.`gate.blocking`in JSON plus the`would block` line gives CI everything it needs.

- **Gate block**, inserted immediately after the dry-run branch's `return;` closes (`:520`) and **before** `// Confirmation if not --yes` (`:522`):

```ts
if (result.scan !== undefined && result.scan.gate.blocking) {
  result.failed.push(scanFailureEntry(result.scan.gate.status === "blocked" ? "blocked" : "inconclusive"));
  if (format !== "text") {
    await outputDeployResult(format, result);
  }
  setExitCode(ExitCode.OperationalError);
  return;
}
```

- **Prompt annotation** at `:522-531`: when a non-blocking scan produced findings, the confirm text carries them — `Deploy plex (will pull images first) [scan: 1 critical, 2 high]?`. An operator must not answer "yes" without seeing what the scan found.

Placement rationale, all load-bearing:

| Boundary                                      | Line           | Why the gate sits where it does                                             |
| --------------------------------------------- | -------------- | --------------------------------------------------------------------------- |
| after conflict-validation gate                | `:421`         | the cheaper gate runs first                                                 |
| after `deployComposePath` / `deployExecution` | `:423-425`     | needs the authority-verified compose path and exec options                  |
| before dry-run branch                         | `:443`         | `--dry-run --scan` reports without mutating                                 |
| before confirmation prompt                    | `:522`         | the operator is never asked to confirm a deploy that is about to be refused |
| far before `revalidateDeployBinding`          | `:559`         | the drift recheck must remain the last thing before mutation                |
| far before `pullImages` / `startServices`     | `:574`, `:923` | no image is pulled and no container touched                                 |

### 3.8 CLI flags — `P/src/cli.ts`

Added to the inline `plan` block (after `--explain`, `:563`) **and** the inline `deploy` block (after `--validate-first`, `:428`), identically:

```ts
.option("--scan", "Scan resolved images for known vulnerabilities", false)
.option("--scanner <name>", "Scanner backend: trivy, grype")
.option("--scan-fail-on <severity>",
  "Block at or above severity: none, unknown, negligible, low, medium, high, critical")
```

| Flag                        | Type    | Default                  | Semantics                                                                                             |
| --------------------------- | ------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `--scan`                    | boolean | `false`                  | Opt-in. Runs one `docker compose config` plus one scanner process per distinct image.                 |
| `--scanner <name>`          | string  | **no Commander default** | `trivy` \| `grype`. Resolves CLI → `scan.scanner` → `trivy`. Invalid → exit 2.                        |
| `--scan-fail-on <severity>` | string  | **no Commander default** | Resolves CLI → `scan.failOn` → `none`. Implies nothing; `--scan` is still required. Invalid → exit 2. |

`plan` gains its first `.addHelpText("after", …)` with an `Exit codes:` block plus a `Vulnerability scanning:` paragraph. `deploy`'s existing help text (`:453-470`) gains a `Vulnerability scanning:` paragraph naming the scanner prerequisite, the fail-closed posture, and the gate's position relative to mutation.

No change to `ALWAYS_MUTATING_COMMANDS` (`:69-79`) or `resolveStateLockOperation` (`:81-116`) for #161 — the scan is read-only and `plan --apply` / `deploy` already lock.

### 3.9 Config keys

`P/src/types/config.ts` — import the feature's own types so the consumption site needs **no cast** (explicitly avoiding the `LintIgnoreRule` / `LintIgnoreEntry` split that forces `as LintIgnoreEntry[]` at `P/src/actions/lint.ts:411`):

```ts
import type { ScanConfig } from "./security-scan.js";
```

`RfappsConfig` gains `scan?: ScanConfig;` beside `lint?` (`:147`). `PartialRfappsConfig` gains `scan: Partial<ScanConfig>;` beside `lint` (`:165`). Both stay **optional** so the 27 spec files that build full `RfappsConfig` literals are untouched.

`P/src/lib/config.ts`, `mergeConfig` (after the `lint` branch at `:160-162`):

```ts
scan: {
  scanner: override.scan?.scanner ?? base.scan?.scanner,
  failOn: override.scan?.failOn ?? base.scan?.failOn,
  ignore: override.scan?.ignore ?? base.scan?.ignore ?? [],
  timeoutMs: override.scan?.timeoutMs ?? base.scan?.timeoutMs,
  maxTargets: override.scan?.maxTargets ?? base.scan?.maxTargets,
  concurrency: override.scan?.concurrency ?? base.scan?.concurrency,
},
```

`partialToFull` (after `:239-241`) mirrors it reading `partial.scan?.*` with `ignore: partial.scan?.ignore ?? []`.

Not added to `loadConfigFromEnv`, `generateSampleConfig`, or `generateConfigFromCompose`. `{{ VAR }}` templating works for free — substitution is textual and pre-YAML at `P/src/lib/config.ts:263`.

Shipped example, appended to `rfapps.config.yaml` after the `lint:` block (`:163-168`):

```yaml
# Image vulnerability scanning (opt-in per invocation via --scan)
# scan:
#   scanner: trivy
#   failOn: none
#   ignore:
#     - id: CVE-2024-56171
#       service: plex
#       reason: "no upstream fix in the linuxserver image; not reachable in this configuration"
#       until: "2026-12-31"
```

### 3.10 Human output (stderr)

```
Image Vulnerability Scan
Scanner: trivy 0.58.1
Scope: plex, sonarr, radarr, lidarr (/srv/rfmedia-apps/compose.yml)
Targets: 3 scanned, 2 skipped (lidarr: build-only; radarr: duplicate-image of sonarr), 0 failed
Findings: 41 total - 2 critical, 6 high, 18 medium, 13 low, 2 negligible, 0 unknown (3 suppressed)
Gate: --scan-fail-on high -> BLOCKED

CRITICAL
  plex  lscr.io/linuxserver/plex:1.41.3
    - CVE-2024-45490  expat 2.5.0 -> fixed in 2.6.3
      https://avd.aquasec.com/nvd/cve-2024-45490
    - CVE-2024-37371  krb5 1.20.1 (no fix available)
HIGH
  sonarr  lscr.io/linuxserver/sonarr:4.0.10
    - CVE-2024-6119  openssl 3.3.1 -> fixed in 3.3.2

Notes:
  - suppression for CVE-2023-1111 (plex) expired on 2026-06-30 and is no longer applied
  - plex: 200 of 214 findings shown; counts above are complete

Gate blocked by:
  - plex: CVE-2024-45490 (critical) in expat@2.5.0
  - sonarr: CVE-2024-6119 (high) in openssl@3.3.1
Re-run with --scan-fail-on none to report only, or accept a finding via scan.ignore.
```

Scanner-unavailable:

```
Image Vulnerability Scan
Scanner: trivy (unavailable)
Scope: plex, sonarr (/srv/rfmedia-apps/compose.yml)
Targets: 0 scanned, 0 skipped, 2 failed
Gate: --scan-fail-on critical -> INCONCLUSIVE

FAILED
  plex    scanner-unavailable: trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/
  sonarr  scanner-unavailable: trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/

A scan that cannot run does not pass. Install a scanner, or pass --scan-fail-on none
to keep scanning advisory.
```

Blocked deploy adds, via `logInfo`:

```
Deploy blocked by vulnerability scan. No containers were modified.
```

### 3.11 `--json` output shape

`plan --scan --output json` emits `{ planPath, plan, scan }`. `deploy --scan --output json` emits `DeployResult` with `scan` and, when blocked, the `failed[]` entry.

```json
{
  "planPath": "/home/op/.rfapps/plans/plan-1753900000.json",
  "plan": { "id": "…", "services": [], "summary": {} },
  "scan": {
    "schemaVersion": "security-scan.v1",
    "timestamp": "2026-07-30T18:00:00.000Z",
    "scanner": { "id": "trivy", "binary": "trivy", "version": "0.58.1", "available": true },
    "scope": {
      "services": ["plex", "sonarr", "radarr", "lidarr"],
      "profiles": ["media"],
      "composePath": "/srv/rfmedia-apps/compose.yml"
    },
    "gate": {
      "failOn": "high",
      "status": "blocked",
      "blocking": true,
      "blockedBy": ["plex: CVE-2024-45490 (critical) in expat@2.5.0", "sonarr: CVE-2024-6119 (high) in openssl@3.3.1"]
    },
    "summary": {
      "critical": 2,
      "high": 6,
      "medium": 18,
      "low": 13,
      "negligible": 2,
      "unknown": 0,
      "total": 41,
      "suppressed": 3,
      "targetsScanned": 3,
      "targetsSkipped": 2,
      "targetsFailed": 0
    },
    "images": [
      {
        "status": "scanned",
        "service": "plex",
        "image": "lscr.io/linuxserver/plex:1.41.3",
        "counts": { "critical": 2, "high": 1, "medium": 4, "low": 3, "negligible": 0, "unknown": 0 },
        "suppressed": 1,
        "truncated": false,
        "durationMs": 4210,
        "vulnerabilities": [
          {
            "id": "CVE-2024-45490",
            "severity": "critical",
            "rawSeverity": "CRITICAL",
            "packageName": "expat",
            "installedVersion": "2.5.0",
            "fixedVersion": "2.6.3",
            "reference": "https://avd.aquasec.com/nvd/cve-2024-45490"
          }
        ]
      },
      {
        "status": "skipped",
        "service": "radarr",
        "image": "lscr.io/linuxserver/sonarr:4.0.10",
        "reason": "duplicate-image",
        "scannedBy": "sonarr"
      },
      { "status": "skipped", "service": "lidarr", "image": "", "reason": "build-only" }
    ],
    "notes": ["suppression for CVE-2023-1111 (plex) expired on 2026-06-30 and is no longer applied"]
  }
}
```

Determinism: `scope.services` and `images` are sorted by service name; findings use a total order; `notes` is append-ordered from a fixed sequence of checks; `gate.blockedBy` follows image then finding order. Two runs against the same image with the same scanner DB differ only in `timestamp` and `durationMs`.

### 3.12 Exit codes

`P/src/lib/exit-codes.ts` gains:

```ts
export function resolveScanExitCode(report: Pick<ScanReport, "gate">): ExitCodeValue {
  return report.gate.blocking ? ExitCode.OperationalError : ExitCode.Success;
}

export function setScanExitCode(report: Pick<ScanReport, "gate">): void {
  setExitCode(resolveScanExitCode(report));
}
```

One blocking predicate (`gate.blocking`, computed once by `evaluateScanGate`) drives plan's gate, deploy's gate, and the dry-run `would block` line. No caller re-derives it. `resolveDeployExitCode` is unchanged — deploy's gate pushes into `result.failed`, which that resolver already handles.

### 3.13 Failure-mode matrix

| Situation                                                                                      | `--scan-fail-on none` (default)                                                                                       | `--scan-fail-on <sev>`                                                                         |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Binary missing (`scanner-unavailable`)                                                         | `gate.status: "passed"`; every target `failed`; loud stderr with the install hint; **exit 0**                         | `inconclusive`; **exit 1**; plan skips `--apply`, deploy returns before the prompt             |
| Scanner exited non-zero (`scanner-error`)                                                      | `passed`; per-target failure printed; exit 0                                                                          | `inconclusive`; exit 1                                                                         |
| Per-image timeout (`timeout`)                                                                  | `passed`; exit 0                                                                                                      | `inconclusive`; exit 1                                                                         |
| stdout exceeded 32 MiB (`output-limit`)                                                        | `passed`; exit 0                                                                                                      | `inconclusive`; exit 1                                                                         |
| Unparsable / shape-drifted report (`invalid-report`)                                           | `passed`; exit 0 — **never zero findings silently**; the target is explicitly `failed` and counted in `targetsFailed` | `inconclusive`; exit 1                                                                         |
| Findings below threshold                                                                       | `passed`; exit 0                                                                                                      | `passed`; exit 0                                                                               |
| Findings at or above threshold                                                                 | `passed` (threshold is `none`); exit 0                                                                                | `blocked`; exit 1; deploy pushes `VULNERABILITY_THRESHOLD` into `failed[]` and mutates nothing |
| Offline / air-gapped host, scanner present but DB fetch fails                                  | `scanner-error` → `passed`; exit 0                                                                                    | `inconclusive`; exit 1                                                                         |
| `docker compose config` fails                                                                  | exit 1 via local `DockerCommandError` formatting                                                                      | same                                                                                           |
| Invalid `--scanner` / `--scan-fail-on` value, blank `scan.ignore[].reason`, unparsable `until` | exit 2 via `InvalidArgumentError` → `handleCliError`                                                                  | same                                                                                           |
| `deploy --dry-run --scan` with a would-block gate                                              | exit 0 + report                                                                                                       | exit 0 + report + `would block` line                                                           |
| `plan --dry-run --scan`                                                                        | no scan runs (dry-run short-circuits before generation); exit 0                                                       | same                                                                                           |

---

## 4. #162 — `rfapps harden`

### 4.1 The two inputs, and why

`getComposeConfig` returns the **resolved, merged** config: YAML anchors (`<<: *service-base`, `logging: *logging-default`), `extends`, and `${VAR}` interpolation are already flattened by Docker. That is exactly right for _detecting_ (it never proposes something an anchor already supplies) and unusable for _writing back_.

So harden has two inputs:

- **Detection** reads the resolved config from `getComposeConfig(composePath, { profiles, envFile: finalConfig.envFile, envTool })`. **`envFile` is mandatory** — `P/src/actions/lint.ts:392` omits it, which makes `${DOCKERLOGGING_MAXSIZE}` interpolate to `""` and `hasLogRotation` treat `""` as missing, producing 42 spurious findings on this repo. `P/src/actions/audit.ts:126` passes it; follow audit.
- **Patching** reads and edits the _source_ `compose.yml` through `parseDocument` from `yaml` — the comment- and anchor-preserving CST path already used by `applyImport` (`P/src/actions/drift.ts:269-345`).

### 4.2 Verified facts that shape the design

Measured against this repo's `compose.yml` using the repo's own `yaml` dependency:

1. `logging: *logging-default` appears on **42 of 47** services; `<<: *service-base` on **42**.
2. `doc.getIn(["services","docktail","logging"], true)` is an **Alias** node, and `doc.setIn(["services","docktail","logging","options","max-size"], "10m")` **throws** `Expected YAML collection at logging. Remaining path: options,max-size`. It does not silently corrupt — but an uncaught throw out of a "pure string → string" module is still a defect.
3. A **top-level** `doc.setIn(["services","docktail","cap_drop"], ["ALL"])` succeeds and leaves `<<: *service-base` intact. Compose semantics: a local key overrides the merge.
4. `parseDocument(src).toString()` is **not** byte-identical to the source. With `{ lineWidth: 0, flowCollectionPadding: false }` the delta collapses to **exactly one hunk** (`authentik-server.healthcheck.test`, a prettier-wrapped flow sequence, 7 source lines → 1 output line).
5. `compose.yml:1117` gives `lidarr` a `build:` context.

### 4.3 `P/src/types/hardening.ts` (new, ~180 lines)

```ts
import type { AuditRuleId } from "./audit.js";
import type { LintRuleId } from "./lint.js";
import type { GlobalOptions, ServiceTargetOptions, ComposeOptions } from "./options.js";
import type { OutputFormat } from "@rfmedia/common";

export const HARDEN_SCHEMA_VERSION = "harden.v1" as const;

/** Reuses the compose vocabulary; harden proposals remediate lint/audit findings. */
export type HardenSeverity = "error" | "warn" | "info";

export type HardenCategory =
  | "capabilities"
  | "identity"
  | "filesystem"
  | "logging"
  | "limits"
  | "health"
  | "availability";

/**
 * How a proposal may be written.
 *  safe      -> mechanical and workload-neutral; eligible for --apply by default
 *  review    -> can break the workload; excluded from every write unless --include-review
 *  advisory  -> no safe automatic value exists; never written, ever
 */
export type HardenConfidence = "safe" | "review" | "advisory";

/** Namespaced so they never collide with LintRuleId or AuditRuleId. */
export type HardenRuleId =
  | "harden-no-new-privileges"
  | "harden-cap-drop-all"
  | "harden-log-rotation"
  | "harden-restart-policy"
  | "harden-read-only-rootfs"
  | "harden-run-as-non-root"
  | "harden-healthcheck"
  | "harden-memory-limit"
  | "harden-cpu-limit";

export type HardenMode = "propose" | "override" | "apply";

/** JSON-serializable compose value. Recursive, never `any`. */
export type HardenPatchValue =
  | string
  | number
  | boolean
  | readonly HardenPatchValue[]
  | { readonly [key: string]: HardenPatchValue };

/**
 * The three operations the YAML engine understands. A new rule composed from
 * these needs zero engine changes.
 *  set          -> overwrite (or create) the node at key
 *  merge-unique -> union a sequence into an existing sequence, order-preserving
 *  remove       -> delete the node at key
 */
export type HardenPatchOperation = "set" | "merge-unique" | "remove";

/**
 * One compose edit.
 *
 * INVARIANT: `key` is a single top-level key under `services.<name>`. Nested
 * paths are forbidden by design (see the alias/merge hazard) and enforced by a
 * spec; a rule needing a nested write must be `advisory` instead.
 */
export interface HardenPatch {
  readonly key: string;
  readonly operation: HardenPatchOperation;
  /** Omitted for "remove". Must be an array for "merge-unique". */
  readonly value?: HardenPatchValue;
  /** One-line human rendering, e.g. `security_opt += ["no-new-privileges:true"]`. */
  readonly description: string;
}

export interface HardenRule {
  readonly id: HardenRuleId;
  readonly category: HardenCategory;
  readonly severity: HardenSeverity;
  readonly confidence: HardenConfidence;
  readonly title: string;
  readonly rationale: string;
  /** Guidance for advisory rules; also shown for patchable ones. */
  readonly guidance: string;
  /** Provenance: the lint/audit rule this remediates. Keeps the catalogs coherent. */
  readonly detects: { readonly lint?: LintRuleId; readonly audit?: AuditRuleId };
}

export interface HardenProposal {
  readonly ruleId: HardenRuleId;
  readonly service: string;
  readonly category: HardenCategory;
  readonly severity: HardenSeverity;
  /** May be downgraded from the rule default by the rule's own detection. */
  readonly confidence: HardenConfidence;
  readonly title: string;
  readonly rationale: string;
  readonly guidance: string;
  readonly detects: { readonly lint?: LintRuleId; readonly audit?: AuditRuleId };
  /** Why the rule fired, in operator language. */
  readonly evidence: readonly string[];
  /** Extra caution, e.g. "plex has writable bind mounts". */
  readonly note?: string;
  /** Empty for advisory proposals. */
  readonly patches: readonly HardenPatch[];
}

export type HardenRefusalCode =
  /** The target key is a YAML alias (*anchor); editing it would change every sharer. */
  | "alias-target"
  /** The service is absent from the compose document. */
  | "service-missing"
  /** The existing node is not the kind the operation requires. */
  | "unexpected-node"
  /** Defensive: a patch declared a nested path. Should be unreachable. */
  | "nested-path";

export interface HardenRefusal {
  readonly code: HardenRefusalCode;
  readonly service: string;
  readonly ruleId: HardenRuleId;
  readonly detail: string;
  /** What to do instead. Always populated. */
  readonly alternative: string;
}

export interface HardenSuppression {
  readonly rule: HardenRuleId | "*";
  readonly service?: string;
  /** Optional: suppressing "add a healthcheck" needs no justification trail. */
  readonly reason?: string;
}

export interface HardenSummary {
  readonly total: number;
  readonly safe: number;
  readonly review: number;
  readonly advisory: number;
  readonly suppressed: number;
  readonly servicesAffected: number;
  /** Patches actually written. Always 0 in propose mode. */
  readonly applied: number;
  readonly refused: number;
}

export interface HardenScope {
  readonly services: readonly string[];
  readonly profiles: readonly string[];
  readonly composePath: string;
}

/** Disclosure of serialization churn --apply would introduce on untouched lines. */
export interface HardenReformat {
  /** True when parse -> canonical serialize is not byte-identical to the source. */
  readonly wouldReformat: boolean;
  /** Line-count delta of the canonical serialization vs the source. */
  readonly lineDelta: number;
}

export type HardenWriteOutcome =
  | { readonly mode: "propose" }
  | { readonly mode: "override"; readonly path: string; readonly patchesWritten: number }
  | {
      readonly mode: "apply";
      readonly path: string;
      readonly backupPath?: string;
      readonly patchesWritten: number;
      readonly servicesPatched: readonly string[];
    };

export interface HardenResult {
  readonly schemaVersion: typeof HARDEN_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly mode: HardenMode;
  readonly includeReview: boolean;
  readonly scope: HardenScope;
  readonly summary: HardenSummary;
  readonly proposals: readonly HardenProposal[];
  readonly refusals: readonly HardenRefusal[];
  readonly reformat: HardenReformat;
  /** Compose override document holding the writable patches. "" when none. */
  readonly override: string;
  readonly write: HardenWriteOutcome;
}

/** `harden:` section of rfapps.config.yaml. */
export interface HardenConfig {
  readonly ignore?: readonly HardenSuppression[];
  readonly rules?: readonly HardenRuleId[];
  readonly includeReview?: boolean;
  /** Take a compose.yml.bak before --apply. Default true. */
  readonly backup?: boolean;
}

export interface HardenOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  readonly apply: boolean;
  readonly overridePath?: string;
  readonly includeReview: boolean;
  readonly rules?: readonly HardenRuleId[];
  readonly listRules: boolean;
  readonly backup: boolean;
  readonly allowReformat: boolean;
  readonly output?: OutputFormat;
}

// --- Harden's own structural view of a resolved compose service. Local by
// --- convention (a third view alongside LintComposeService and
// --- AuditComposeService) so hardening does not inherit lint's type evolution.
export interface HardenComposeVolumeMount {
  readonly target?: string;
  readonly read_only?: boolean;
  readonly bind?: { readonly create_host_path?: boolean };
}

export interface HardenComposeService {
  readonly image?: string;
  readonly build?: unknown;
  readonly restart?: string;
  readonly user?: string;
  readonly privileged?: boolean;
  readonly read_only?: boolean;
  readonly security_opt?: readonly string[];
  readonly cap_add?: readonly string[];
  readonly cap_drop?: readonly string[];
  readonly devices?: readonly string[];
  readonly volumes?: readonly (string | HardenComposeVolumeMount)[];
  readonly logging?: {
    readonly driver?: string;
    readonly options?: Readonly<Record<string, string>>;
  };
  readonly healthcheck?: { readonly test?: unknown } | null;
  readonly deploy?: {
    readonly restart_policy?: unknown;
    readonly resources?: {
      readonly limits?: { readonly memory?: string; readonly cpus?: string | number };
    };
  };
}

export interface HardenComposeConfig {
  readonly services: Readonly<Record<string, HardenComposeService>>;
}
```

### 4.4 The full initial rule set — `P/src/lib/hardening.ts`

Registry-by-array, mirroring `LINT_RULES` (`P/src/lib/lint.ts:64`):

```ts
type EvaluableHardenRule = HardenRule & {
  /** undefined = already satisfied for this service. Pure and synchronous. */
  detect: (
    service: HardenComposeService,
    serviceName: string,
  ) =>
    | undefined
    | {
        readonly evidence: readonly string[];
        readonly note?: string;
        readonly confidence?: HardenConfidence;
      };
  /** Only called when detect returned a value. Empty for advisory rules. */
  propose: (service: HardenComposeService) => readonly HardenPatch[];
};

export const HARDEN_RULES: readonly EvaluableHardenRule[] = [
  /* nine entries, below */
];
export const HARDEN_RULE_IDS: readonly HardenRuleId[] = HARDEN_RULES.map((rule) => rule.id);
```

| #   | id                         | sev    | category     | confidence   | Detects (predicate on the **resolved** service)                                                                                                                   | Rationale                                                                                                                       | Proposed remediation                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------- | ------ | ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `harden-no-new-privileges` | `info` | capabilities | **safe**     | `security_opt` does not include `no-new-privileges:true`. Provenance: lint `no-new-privileges-missing`.                                                           | A setuid binary inside the container can still escalate; the flag closes that path with no functional cost for these workloads. | `merge-unique security_opt ["no-new-privileges:true"]` — value written is the **union of the resolved list and the new entry**.                                                                                                                                                                                      |
| 2   | `harden-restart-policy`    | `warn` | availability | **safe**     | No `restart` (or empty) **and** no `deploy.restart_policy`. Provenance: lint `restart-policy-missing`.                                                            | Without a policy the container stays stopped after host reboot or unexpected exit.                                              | `set restart "unless-stopped"` — matches `x-service-base` in this repo.                                                                                                                                                                                                                                              |
| 3   | `harden-log-rotation`      | `warn` | logging      | **safe**     | `logging.options["max-size"]` absent or empty. Provenance: lint `log-rotation-missing`.                                                                           | Unbounded container logs fill disk and take down every service on the host.                                                     | `set logging { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } }` — the **whole** `logging` map, because compose overrides replace it wholesale. **In this repo `logging` is `*logging-default` on 42 services, so this patch is alias-refused; the refusal names `--out` as the alternative.** |
| 4   | `harden-cap-drop-all`      | `info` | capabilities | **review**   | `cap_drop` does not include `ALL`. Provenance: lint `cap-drop-missing`, audit `cap-drop-missing`. Adds `note` when `hasCapAdd(service)` or `hasDevices(service)`. | Dropping every capability and re-adding only what is used minimises post-compromise capability.                                 | `merge-unique cap_drop ["ALL"]`. `review` because a container silently depending on a default capability (`NET_RAW` for ping, `CHOWN` in linuxserver init) breaks on next recreate.                                                                                                                                  |
| 5   | `harden-read-only-rootfs`  | `info` | filesystem   | **review**   | `read_only !== true`. Provenance: lint `read-only-rootfs`. Adds `note` when `hasWritableBindMounts(service)`.                                                     | A writable root filesystem lets a compromised process persist changes inside the container.                                     | `set read_only true`. `review` because every writable path must first be a tmpfs or volume mount.                                                                                                                                                                                                                    |
| 6   | `harden-run-as-non-root`   | `warn` | identity     | **review**   | `runsAsRoot(service)` (`user` absent, `"0"`, `"root"`, or `0:*`). Provenance: audit `root-user`.                                                                  | A root process shares uid 0 with the host, so a container escape or a writable bind mount becomes host-level compromise.        | `set user "${PUID}:${PGID}"` — this repo's convention, written as a literal `${…}` string so compose interpolates it. `review` because the correct uid:gid depends on ownership of the mounted host paths.                                                                                                           |
| 7   | `harden-healthcheck`       | `warn` | health       | **advisory** | `healthcheck` absent or `null`. Provenance: lint `healthcheck-missing`.                                                                                           | Without a health check, orchestrators cannot detect or replace an unhealthy container.                                          | **None.** rfapps will not invent a probe command; a wrong probe marks a healthy service unhealthy. Guidance names the shape (`test`, `interval`, `timeout`, `retries`, `start_period`).                                                                                                                              |
| 8   | `harden-memory-limit`      | `info` | limits       | **advisory** | `deploy.resources.limits.memory` absent or empty. Provenance: lint `resource-limits-missing`, audit `memory-limit-missing`.                                       | Without a ceiling one runaway service can OOM the whole host.                                                                   | **None.** A ceiling is host- and workload-specific; a wrong value OOM-kills a healthy service.                                                                                                                                                                                                                       |
| 9   | `harden-cpu-limit`         | `info` | limits       | **advisory** | `deploy.resources.limits.cpus` absent or empty. Provenance: audit `cpu-limit-missing`.                                                                            | An unbounded service can starve every other container on the host.                                                              | **None.** Same reason as #8.                                                                                                                                                                                                                                                                                         |

Category coverage vs the issue text: capabilities (1, 4), user (6), filesystem mode (5), logging (3), limits (8, 9), health checks (7), plus availability (2). All six named categories are covered; three are covered as detection + guidance rather than as a fabricated value, which is a stated scope call (§1.2).

**Idempotency** is a rule-level invariant, asserted by a table-driven property test: for each rule, applying its own `propose()` output to a fixture service and re-running `detect()` must return `undefined`. This is why sequence-valued patches use `merge-unique` rather than `set` — `rfapps harden --apply` twice must be a no-op, and `set` would also clobber an existing `security_opt` entry, i.e. a hardening tool weakening security.

Other exports from `lib/hardening.ts`:

```ts
/** @throws {InvalidArgumentError} on unknown targets or unknown rule ids. */
export function evaluateHardening(
  config: HardenComposeConfig,
  targets: readonly string[] | undefined,
  options: {
    readonly suppressions: readonly HardenSuppression[];
    readonly rules?: readonly HardenRuleId[];
  },
): { readonly proposals: readonly HardenProposal[]; readonly suppressed: number };

/** Proposals eligible for a write. Advisory is always excluded. */
export function filterWritableProposals(
  proposals: readonly HardenProposal[],
  includeReview: boolean,
): readonly HardenProposal[];

/** @throws {InvalidArgumentError} on an unknown rule id. */
export function normalizeHardenSuppressions(entries: readonly HardenSuppression[]): readonly HardenSuppression[];

/** @throws {InvalidArgumentError} on an unknown rule id. */
export function parseHardenRuleIds(csv: string | undefined): readonly HardenRuleId[] | undefined;

/** Canonical serialization used for every write and for reformat detection. */
export function serializeComposeDocument(doc: Document): string;

/** Disclosure of churn --apply would cause on untouched lines. Pure. */
export function detectReformat(source: string): HardenReformat;

/** Pure string -> string. No filesystem, no logging, no exit codes. */
export function applyHardenPatches(
  source: string,
  proposals: readonly HardenProposal[],
): {
  readonly content: string;
  readonly patchesWritten: number;
  readonly servicesPatched: readonly string[];
  readonly refusals: readonly HardenRefusal[];
};

/** Compose override document containing only the writable patches. "" when none. */
export function buildHardenOverride(
  proposals: readonly HardenProposal[],
  meta: { readonly composePath: string; readonly timestamp: string; readonly includeReview: boolean },
): { readonly content: string; readonly patchesWritten: number };

export function buildHardenSummary(
  proposals: readonly HardenProposal[],
  suppressed: number,
  applied: number,
  refusals: readonly HardenRefusal[],
): HardenSummary;

export function formatHardenText(result: HardenResult): string[];
export function formatHardenRulesCatalog(): string[];
```

Proposals sort by `confidence` (`safe` < `review` < `advisory`) → service → `HARDEN_RULES` declaration order. Refusals sort by service → ruleId.

### 4.5 Reading compose YAML without corrupting anchors or extension fields

`serializeComposeDocument(doc)` is the **only** serializer, and it is fixed:

```ts
const COMPOSE_SERIALIZE_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

export function serializeComposeDocument(doc: Document): string {
  return doc.toString(COMPOSE_SERIALIZE_OPTIONS);
}
```

These options were chosen by measurement, not taste: they reduce the round-trip delta on this repo's `compose.yml` from many hunks to exactly one.

`applyHardenPatches`:

1. `parseDocument(source)`; if `doc.get("services")` is not a map, return a single `{ code: "unexpected-node", detail: "compose document has no services map" }` refusal and `content === source`. Fail loudly, never a silent no-op.
2. For each proposal (writable set only — the caller filters), for each patch, in order:
   - `patch.key.includes(".")` or any nested-path encoding → `{ code: "nested-path" }`. Defensive; unreachable given the `HardenPatch.key` invariant, and enforced by a spec that scans `HARDEN_RULES`.
   - `serviceNode = doc.getIn(["services", service], true)`; not an `isMap` → `{ code: "service-missing", alternative: "the service is defined outside this compose file; use --out to emit an override fragment" }`.
   - `existing = doc.getIn(["services", service, patch.key], true)`; **`isAlias(existing)` → `{ code: "alias-target", detail: "services.${service}.${patch.key} is a YAML alias (\*anchor); editing it would change every service that shares the anchor", alternative: "use: rfapps harden --rule <id> --out compose.harden.yaml" }`**. This is the load-bearing guard. It catches `logging: *logging-default` on all 42 services.
   - `operation === "set"` → `doc.setIn(["services", service, patch.key], patch.value)`. Safe on a `<<:`-merged service: it creates a local key that overrides the merge and leaves the anchor untouched (verified).
   - `operation === "merge-unique"` → if `existing === undefined`/`null`, `setIn` the full array; if `isSeq(existing)`, append only the entries not already present, order-preserving; otherwise `{ code: "unexpected-node", detail: "services.${service}.${patch.key} is not a sequence" }` — never clobber.
   - `operation === "remove"` → `doc.deleteIn(["services", service, patch.key])`.
3. Return `serializeComposeDocument(doc)` plus counts and refusals.

A refusal is a _reported, non-fatal_ outcome: detection stands, only the automated write is withheld, and the alternative is always named. `--apply` that writes some patches and refuses others exits 3 (partial).

`buildHardenOverride` builds a plain object `{ services: { <name>: { <key>: <value> } } }` and `YAML.stringify`s it with a comment header. Because **compose override merge replaces sequences rather than appending them**, every sequence-valued patch emits the full union computed from the resolved config — getting this wrong would silently drop an existing `security_opt` entry.

### 4.6 Propose-vs-apply model

Mode is derived in the action, never passed as a flag value:

| Flags          | mode       | Side effects                                                                                                             |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| _(none)_       | `propose`  | **Nothing written.** Proposals + refusals + the literal override fragment to stderr, or the full `HardenResult` as JSON. |
| `--out <path>` | `override` | Writes the override YAML to `<path>` with `{ flag: "wx" }` (refuses to clobber). `compose.yml` untouched.                |
| `--apply`      | `apply`    | Edits `compose.yml` in place after a `.bak` copy and a confirmation prompt.                                              |

`--out` and `--apply` are mutually exclusive (`InvalidArgumentError`, exit 2). `--apply` writes **only `safe`** proposals unless `--include-review`; `advisory` proposals are never written, by construction.

**Reformat acknowledgement.** `detectReformat(source)` is computed in every mode and reported. When `wouldReformat === true` and mode is `apply`, the action refuses with `InvalidArgumentError("--apply", …, "writing compose.yml would also reformat lines this command did not target (line delta: <n>); re-run with --allow-reformat to accept, or use --out for a non-destructive override")` — exit 2. `--allow-reformat` proceeds. Nothing is ever silently reformatted, and `--apply` is not dead on arrival: on this repo it needs `--allow-reformat` once (one hunk, +6 lines) or a one-time `prettier`-compatible reflow of that healthcheck.

`--dry-run` (global) suppresses every write in `override` and `apply` mode, prints `formatDryRun(...)` plus the proposal output, and exits 0.

### 4.7 New command + flags — `P/src/commands/harden.ts`

Registrar module following `P/src/commands/audit.ts` verbatim in style, with `backup.ts`'s injected-dependency variant so command-level validation is testable and can be reused by the `preAction` hook.

```ts
import type { Command } from "commander";

export interface HardenCommandDependencies {
  loadAction(): Promise<{ executeHarden: ExecuteHarden }>;
}

/** @throws {InvalidArgumentError} on incoherent flag combinations. */
export function validateHardenOptions(options: RawHardenOptions): void;

export function registerHardenCommand(
  program: Command,
  dependencies: HardenCommandDependencies = defaultDependencies,
): void;
```

```
rfapps harden [options]

  -s, --service <name>      Target a specific service
      --services <names>    Target multiple services (comma-separated)
  -g, --group <name>        Target a service group
      --no-sidecars         Disable automatic sidecar linking
      --apply               Edit compose.yml in place (requires confirmation)
  -o, --out <path>          Write a compose override fragment to <path>
      --include-review      Include review-confidence rules in written output
      --rule <ids>          Restrict to a comma-separated rule allowlist
      --list-rules          Print the rule catalog and exit
      --no-backup           Skip the compose.yml.bak copy taken before --apply
      --allow-reformat      Accept incidental YAML reformatting of untouched lines
  -f, --compose <path>      Path to Docker Compose file
  -e, --env-file <path>     Path to environment file
  -p, --profile <name>      Docker Compose profile to use
      --json                Output the harden result in JSON format
```

`validateHardenOptions` rejects, all exit 2: `--apply` with `--out`; `--out` absent while `--include-review`/`--allow-reformat`/`--no-backup` were passed without a write mode; `--allow-reformat` without `--apply`; `--no-backup` without `--apply`; `--apply` with a machine `--output` and without `--yes` (a prompt cannot be answered in a JSON pipeline — same posture as `drift import`).

`.configureHelp({ showGlobalOptions: true })` and:

```
Non-destructive by default: with no write flag, harden resolves compose
configuration, reports proposed hardening, and prints an editable compose
override fragment. It writes nothing and does not touch containers, images, or
recorded state.

Proposals are split by confidence. `safe` changes are mechanical and
workload-neutral. `review` changes (cap_drop ALL, read-only rootfs, non-root
user) can break a workload and are excluded from writes unless --include-review.
Health checks and resource limits are advisory only: rfapps will not invent a
probe command or a memory ceiling.

--apply refuses any edit whose target key is a YAML alias, because that would
change every service sharing the anchor; the refusal names the --out
alternative. It also refuses when serializing compose.yml would reformat lines
this command did not target, unless --allow-reformat is passed.

Rule suppressions come from the `harden.ignore` section of rfapps.config.yaml.

Exit codes:
  0  Proposals reported, override written, or apply completed
  1  Compose resolution failed, or a write failed
  2  Usage error, or --apply would reformat untargeted lines without --allow-reformat
  3  Apply completed with some patches refused
```

**`P/src/cli.ts`:** `import { registerHardenCommand } from "./commands/harden.js";` in the alphabetical import block (`:45-57`, between `force-unlock` and `import`), and `registerHardenCommand(program);` placed immediately **after** the inline `lint` block closes (`:603`) so help ordering reads `lint → harden` (detect → remediate), mirroring how `registerDriftCommand(program)` sits after `plan` at `:570`.

State lock — a new branch in `resolveStateLockOperation`, beside the `plan || update` branch (`:105-107`):

```ts
if (commandName === "harden") {
  return options["apply"] === true ? "harden" : undefined;
}
```

`harden` is **not** added to `ALWAYS_MUTATING_COMMANDS`: propose and `--out` are read-only with respect to `compose.yml`. `--apply` mutates the same shared resource `drift import` locks, so without this branch two compose writers could interleave and lose one set of edits. Note `resolveStateLockOperation` already returns `undefined` when `globalOptions["dryRun"] === true`.

`P/src/cli.ts` `preAction` hook (`:185+`) gains a `harden` case calling `validateHardenOptions(actionCommand.opts())` so bad flag combinations fail before the lock is taken.

### 4.8 `P/src/actions/harden.ts` (new, ~250 lines)

Body order copied from `P/src/actions/audit.ts:55-170`, with the `drift import` mutation envelope:

1. `getEnvToolExecConfig(globalOptions)`; build `HardenOptions`; resolve format with a three-line `resolveHardenFormat` mirroring `resolveAuditFormat` (`P/src/actions/audit.ts:40-53`).
2. `validateHardenOptions(rawOptions)` (idempotent; also called from the hook).
3. `--list-rules` → `formatHardenRulesCatalog()` to stderr; return 0.
4. `loadConfig()` → `isValidProfile` guard throwing `InvalidArgumentError("--profile", …)` → `applyCliOverrides(config, { composePath, envFile, profile, noSidecars })`.
5. Resolve settings: `includeReview = rawOptions.includeReview === true || (finalConfig.harden?.includeReview ?? false)`; `backup = rawOptions.backup !== false && (finalConfig.harden?.backup ?? true)`; `rules = parseHardenRuleIds(rawOptions.rule) ?? finalConfig.harden?.rules`; `suppressions = normalizeHardenSuppressions(finalConfig.harden?.ignore ?? [])`.
6. `resolveServicesWithInteractive(...)`; `if (resolved === null) return;`.
7. `getComposeConfig(finalConfig.composePath, { profiles, envFile: finalConfig.envFile, envTool })`. `undefined` → local `DockerCommandError("config", …)` + `outputFormattedError(formatError(error))` + `setExitCode(ExitCode.OperationalError)` + return. **Never a bare throw from this path.**
8. `evaluateHardening(composeConfig as unknown as HardenComposeConfig, targets, { suppressions, rules })` — the same deliberate double-cast as `P/src/actions/lint.ts:410` and `P/src/actions/audit.ts:145`, because `ComposeServiceConfig` in `docker.ts` is intentionally narrow.
9. `const source = await readFile(finalConfig.composePath, "utf8");` → `const reformat = detectReformat(source);` → `const writable = filterWritableProposals(proposals, includeReview);` → `const applied = applyHardenPatches(source, writable);` (computed in **every** mode, so the refusals reported in propose mode are exactly the refusals `--apply` would hit) → `const override = buildHardenOverride(writable, meta);`.
10. Mode branch:
    - `propose`: `write = { mode: "propose" }`; `summary.applied = 0`.
    - `override`: `--dry-run` → `formatDryRun` + return; `writeFile(overridePath, override.content, { encoding: "utf8", flag: "wx" })`; an `EEXIST` becomes `InvalidArgumentError("--out", path, "file already exists")`.
    - `apply`: refuse on `reformat.wouldReformat && !allowReformat` (exit 2); skip entirely when `writable.length === 0` (log "no writable patches" and emit propose output); `--dry-run` → `formatDryRun` + return; `if (!options.yes && !isMachineFormat(format))` → `confirm("Apply ${applied.patchesWritten} hardening patch(es) to ${applied.servicesPatched.length} service(s) in ${composePath}?")`, cancel → `logInfo("Cancelled")` + return 0; `if (backup) await copyFile(composePath, "${composePath}.bak")`; `await writeFile(composePath, applied.content, "utf8")`. Wrap the backup+write in `try/catch` and, on failure,`outputFormattedError(formatError(new DockerCommandError("harden", message, 1, servicesPatched, false)))`+`setExitCode(ExitCode.OperationalError)`— the`executeDriftImport` shape (`P/src/actions/drift.ts:762-778`).
11. Output: `format !== "text"` → `await formatOutput(format, result)`; else `for (const line of formatHardenText(result)) console.error(line);`.
12. `setHardenExitCode(result)`.

`table`/`csv` are not special-cased: harden is not MCP-surfaced, `proposals`/`refusals`/`override` are documented as JSON/YAML-only detail, and `formatOutput` handles flattening.

### 4.9 Patch / diff output format

**Text (stderr), propose mode:**

```
Security Hardening Proposals  (mode: propose -- nothing written)
Compose: /srv/rfmedia-apps/compose.yml
Scope: plex, sonarr, radarr (profiles: media)
Proposals: 14 total - 6 safe, 5 review, 3 advisory | 2 suppressed | 4 refused

SAFE - write with `rfapps harden --apply`
  sonarr
    info  harden-no-new-privileges   security_opt += ["no-new-privileges:true"]
          Blocks setuid privilege escalation inside the container.
          detects: lint/no-new-privileges-missing
  radarr
    warn  harden-restart-policy      restart = "unless-stopped"
          detects: lint/restart-policy-missing

REVIEW - verify the workload first: `rfapps harden --apply --include-review`
  plex
    info  harden-read-only-rootfs    read_only = true
          evidence: read_only absent; writable bind mounts: ${DOCKER_DIR}/plex
          note: add a tmpfs for transcode scratch before enabling this
          detects: lint/read-only-rootfs

ADVISORY - no safe automatic value exists
  plex
    warn  harden-healthcheck   Add a service-specific healthcheck. rfapps will not
                               invent a probe command; a wrong probe marks a healthy
                               service unhealthy.
    info  harden-memory-limit  Set deploy.resources.limits.memory explicitly.
                               Ceilings are host-dependent and rfapps will not guess.

REFUSED - reported, not written
  sonarr  harden-log-rotation  services.sonarr.logging is a YAML alias
          (*logging-default); editing it would change every service that shares
          the anchor.
          -> use: rfapps harden --rule harden-log-rotation --out compose.harden.yaml

Suppressed by config: harden-run-as-non-root (traefik), harden-memory-limit (plex)

Note: writing compose.yml would also reformat 1 region this command did not
      target (line delta: +6). --apply requires --allow-reformat, or use --out.

Compose override fragment (usable as `docker compose -f compose.yml -f compose.harden.yaml up -d`):

# Generated by rfapps harden at 2026-07-30T18:00:00.000Z
# Source: /srv/rfmedia-apps/compose.yml
# Apply with: docker compose -f compose.yml -f compose.harden.yaml up -d
# Safe-confidence rules only. Re-run with --include-review to include review rules.
services:
  sonarr:
    security_opt:
      - no-new-privileges:true
  radarr:
    restart: unless-stopped
```

**Apply mode** replaces the header and closing blocks with:

```
Security Hardening  (mode: apply)
Backup: /srv/rfmedia-apps/compose.yml.bak
Applied 6 patch(es) to 4 service(s); 5 review and 3 advisory proposal(s) untouched.
Refused 4 patch(es) (see above). Exit code 3 (partial).
```

There is deliberately no unified diff: the `SAFE`/`REVIEW` blocks name every key and value that would be written, the override fragment renders them as literal YAML, and the `Note:` line discloses serialization churn as a count. See decision 9.

### 4.10 `--json` output shape

```json
{
  "schemaVersion": "harden.v1",
  "timestamp": "2026-07-30T18:00:00.000Z",
  "mode": "propose",
  "includeReview": false,
  "scope": {
    "services": ["plex", "sonarr", "radarr"],
    "profiles": ["media"],
    "composePath": "/srv/rfmedia-apps/compose.yml"
  },
  "summary": {
    "total": 14,
    "safe": 6,
    "review": 5,
    "advisory": 3,
    "suppressed": 2,
    "servicesAffected": 3,
    "applied": 0,
    "refused": 4
  },
  "proposals": [
    {
      "ruleId": "harden-no-new-privileges",
      "service": "sonarr",
      "category": "capabilities",
      "severity": "info",
      "confidence": "safe",
      "title": "no-new-privileges not set",
      "rationale": "A setuid binary inside the container can still escalate privileges.",
      "guidance": "Add `security_opt: [\"no-new-privileges:true\"]` unless the service requires privilege escalation.",
      "detects": { "lint": "no-new-privileges-missing" },
      "evidence": ["security_opt does not include no-new-privileges:true"],
      "patches": [
        {
          "key": "security_opt",
          "operation": "merge-unique",
          "value": ["no-new-privileges:true"],
          "description": "security_opt += [\"no-new-privileges:true\"]"
        }
      ]
    },
    {
      "ruleId": "harden-healthcheck",
      "service": "plex",
      "category": "health",
      "severity": "warn",
      "confidence": "advisory",
      "title": "Health check missing",
      "rationale": "Without a health check, orchestrators cannot detect or replace an unhealthy container.",
      "guidance": "Add a `healthcheck` block with a service-specific `test`, `interval`, `timeout`, `retries`, and `start_period`.",
      "detects": { "lint": "healthcheck-missing" },
      "evidence": ["healthcheck absent"],
      "patches": []
    }
  ],
  "refusals": [
    {
      "code": "alias-target",
      "service": "sonarr",
      "ruleId": "harden-log-rotation",
      "detail": "services.sonarr.logging is a YAML alias (*logging-default); editing it would change every service that shares the anchor",
      "alternative": "use: rfapps harden --rule harden-log-rotation --out compose.harden.yaml"
    }
  ],
  "reformat": { "wouldReformat": true, "lineDelta": 6 },
  "override": "# Generated by rfapps harden at 2026-07-30T18:00:00.000Z\nservices:\n  sonarr:\n    security_opt:\n      - no-new-privileges:true\n",
  "write": { "mode": "propose" }
}
```

Apply mode replaces `write` with `{ "mode": "apply", "path": "/srv/…/compose.yml", "backupPath": "/srv/…/compose.yml.bak", "patchesWritten": 6, "servicesPatched": ["radarr","sonarr"] }`. Determinism: proposals sorted `confidence → service → declaration order`; `patches` in declaration order; `refusals` sorted `service → ruleId`.

`override.content` carries the fragment as a string so CI can `jq -r '.override' > compose.harden.yaml` without a second invocation.

### 4.11 Config keys

`P/src/types/config.ts` adds `import type { HardenConfig } from "./hardening.js";`, `harden?: HardenConfig;` on `RfappsConfig`, and `harden: Partial<HardenConfig>;` on `PartialRfappsConfig`. `P/src/lib/config.ts` adds the matching `mergeConfig` and `partialToFull` branches following the `lint:` shape exactly (`ignore: … ?? []`, `rules: … ?? []`). No `RFAPPS_HARDEN_*` env override — nothing here belongs in an env var.

`rfapps.config.yaml` gains a commented block reusing this deployment's real rationale:

```yaml
# Security hardening rule suppressions (`rfapps harden`)
# harden:
#   includeReview: false
#   backup: true
#   ignore:
#     - rule: harden-memory-limit
#       service: plex          # GPU workload; limits are host-dependent
#     - rule: harden-run-as-non-root
#       service: traefik       # binds :80/:443
```

### 4.12 Exit codes

`P/src/lib/exit-codes.ts` gains:

```ts
export function resolveHardenExitCode(result: Pick<HardenResult, "write" | "refusals">): ExitCodeValue {
  if (result.write.mode === "apply" && result.write.patchesWritten > 0 && result.refusals.length > 0) {
    return ExitCode.PartialSuccess;
  }
  return ExitCode.Success;
}

export function setHardenExitCode(result: Pick<HardenResult, "write" | "refusals">): void {
  setExitCode(resolveHardenExitCode(result));
}
```

| Situation                                                                                                                                    | Code                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| propose mode, any number of proposals or refusals                                                                                            | 0                                                           |
| `--out` wrote the fragment                                                                                                                   | 0                                                           |
| `--apply` wrote everything requested                                                                                                         | 0                                                           |
| `--apply` wrote some patches, refused others                                                                                                 | 3 (`PartialSuccess`)                                        |
| `--apply` cancelled at the prompt                                                                                                            | 0 (cancellation is not an error — matches `drift import`)   |
| compose resolution failed, or backup/write failed                                                                                            | 1 via local `DockerCommandError` formatting + `setExitCode` |
| `--apply` + `--out`, `--out` on an existing file, `--allow-reformat` needed and absent, invalid `--profile`, unknown target, unknown rule id | 2 via `InvalidArgumentError` → `handleCliError`             |

**Harden is never a findings gate** and has no `--fail-on`. Refusing to make an unsafe edit is correct behaviour; reporting that as exit 1 would train operators to ignore harden's exit code.

---

## 5. Ancillary surfaces

### 5.1 Shell completion — `P/src/actions/completion.ts` (hand-maintained, all three generators)

**bash (`generateBashCompletion`)**

| Site                   | Line                        | Change                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| command list           | `:40`                       | append `harden` to the `local commands="… audit doctor …"` list                                                                                                                                                                                                                 |
| `deploy_opts`          | `:53`                       | append `--scan`, `--scanner`, `--scan-fail-on`                                                                                                                                                                                                                                  |
| `plan_opts`            | `:71`                       | append `--scan`, `--scanner`, `--scan-fail-on`                                                                                                                                                                                                                                  |
| new opts var           | after `:117` (`audit_opts`) | `local harden_opts="--service --services --group --no-sidecars --apply --out --include-review --rule --list-rules --no-backup --allow-reformat --compose --env-file --profile --json"`                                                                                          |
| command-detection case | `:175`                      | add `\|harden` to the alternation                                                                                                                                                                                                                                               |
| `case "$prev"`         | after `:293` (`--fail-on)`) | `--scanner) COMPREPLY=($(compgen -W "trivy grype" -- "$cur")); return;;` and `--scan-fail-on) COMPREPLY=($(compgen -W "none unknown negligible low medium high critical" -- "$cur")); return;;` and `--rule) COMPREPLY=($(compgen -W "<HARDEN_RULE_IDS>" -- "$cur")); return;;` |
| dispatch arm           | after `:403` (`audit)`)     | `harden) COMPREPLY=($(compgen -W "$harden_opts $global_opts" -- "$cur")) ;;`                                                                                                                                                                                                    |

`--out` already reaches `_filedir` via the `--compose\|-f\|…\|--out\|-o\|…` arm at `:256`; `-s`/`--service`/`--services` already route to `__rfapps_service_completion` unconditionally at `:274`, so no allowlist edit is needed.

**zsh (`generateZshCompletion`)**

| Site                    | Line                        | Change                                                                                                                                                                                                                           |
| ----------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands=()`           | after `:501` (`'audit:…'`)  | `'harden:Propose or apply compose security hardening'`                                                                                                                                                                           |
| `__rfapps_find_command` | `:531`                      | add `\|harden` to the alternation                                                                                                                                                                                                |
| `deploy)` `_arguments`  | `:621-643`                  | add `'--scan[Scan resolved images for known vulnerabilities]'`, `'--scanner[Scanner backend]:scanner:(trivy grype)'`, `'--scan-fail-on[Block at or above severity]:severity:(none unknown negligible low medium high critical)'` |
| `plan)` `_arguments`    | `:695-710`                  | same three lines                                                                                                                                                                                                                 |
| new `harden)` arm       | after `:904` (`audit)` arm) | `_arguments` block with the full harden option set, `'--rule[Restrict to specific rules]:rules:_values -s , rule <HARDEN_RULE_IDS>'`, `'(-o --out)'{-o,--out}'[Override fragment path]:file:_files'`                             |

**fish (`generateFishCompletion`)**

| Site                           | Line                        | Change                                                                                                                                                                             |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| subcommand list                | after `:1162` (`audit`)     | `complete -c rfapps -n "__fish_use_subcommand" -a "harden" -d "Propose or apply compose security hardening"`                                                                       |
| `# Deploy command options`     | `:1212-1232`                | three `complete -c rfapps -n "__fish_seen_subcommand_from deploy" …` lines; `--scanner -xa "trivy grype"`, `--scan-fail-on -xa "none unknown negligible low medium high critical"` |
| `# Plan command options`       | `:1288-1301`                | same three lines for `plan`                                                                                                                                                        |
| new `# Harden command options` | after `:1403` (audit block) | 14 lines modelled on the audit block                                                                                                                                               |

`harden` collides with no existing subcommand token, so no `; and not __fish_seen_subcommand_from …` carve-out is needed.

`docs/features/shell-completion.md` mirrors this in prose: the command list at `:120-121` and the per-command option blocks at `:141-216`.

**`P/src/actions/completion.spec.ts` — required, CI-breaking otherwise.** Widen `getCommanderCommandOptions`'s and `getCommandCompletionOptions`'s command unions (`:168`, `:186`) from `"deploy" | "rebuild"` to `"deploy" | "rebuild" | "plan" | "harden"`, add parity cases for `plan` and `harden`, and add `"harden"` to the hardcoded command list (`:362-390`). The extractors are already generic over the command name. Note the option name is `no-backup` (Commander renders only the negated form for `.option("--no-backup", …)`), so the completion templates must carry `--no-backup`, not `--backup`.

### 5.2 MCP schema mirror — **no changes required, for either issue**

Verified in-repo, not assumed:

- `deployResultSchema` (`P/src/mcp/schema.ts:297-304`) does **not** mirror the existing `DeployResult.validation?` field (`P/src/types/results.ts:119`).
- `deployInputSchema` (`P/src/mcp/schema.ts:825-836`) does **not** carry `validateFirst`.
- `planInputSchema` (`P/src/mcp/schema.ts:872-880`) carries `apply`, `out`, `showUnchanged`, `checkUpdates`, `explain` — nothing else.
- `invokeDeploy` and `invokePlan` (`P/src/mcp/adapters.ts:403-427`) pass an explicit, closed field list to the actions.

Because `scan`, `scanner`, and `scanFailOn` are **not** added to `planInputSchema` or `deployInputSchema` and **not** forwarded by the adapters, `options.scan` is always `undefined` on the MCP path, so `plan.scan` / `DeployResult.scan` can never be produced there and the closed output schemas can never see an unexpected key. This is exactly the invariant that already protects `validation?`.

`harden` is not MCP-surfaced (neither are `lint`, `audit`, or `doctor`), so `RFAPPS_MCP_TOOL_NAMES`, `rfappsMcpSchemas`, `rfappsActionAdapters`, `tools-read.ts`, `tools-mutate.ts`, and the 16-name catalog assertion at `P/src/mcp/server.spec.ts:170-188` are untouched.

**This invariant must be recorded** in `P/CLAUDE.md` next to the existing closed-schema warning: _if a future change adds `scan`/`scanner`/`scanFailOn` to `planInputSchema` or `deployInputSchema`, `scanReportSchema` must be mirrored into `planResultSchema` (`:522`) and `deployResultSchema` (`:297`) in the same commit; `schemaObject` is `additionalProperties: false`, an omitted optional field typechecks clean, and the failure appears only at MCP runtime._

### 5.3 New feature docs

| New file                                                      | Model                                   | Sections                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/features/rfapps-vulnerability-scanning.md` (~200 lines) | `docs/features/rfapps-drift-command.md` | H1 + lead + advisory-scope sentence · Read-Only Guarantees · Usage · Scanner Backends and Prerequisites · Scan Targets and Skips (build-only, duplicate-image, target cap) · Severity Model and Thresholds · Fail-Closed Semantics (the failure-mode matrix from §3.13) · Suppressions and Expiry · Plan Integration · Deploy Gate Position · JSON Output · Exit Behavior · Limitations (mutable tags, pre-pull timing, no digest pinning, no cache, `execWithEnv` single-child SIGTERM) · Related Documentation |
| `docs/features/rfapps-harden-command.md` (~220 lines)         | `docs/features/rfapps-backup.md`        | H1 + lead + non-destructive guarantee · Command Syntax (option table + examples) · Rule Catalog (the §4.4 table) · Safe vs Review vs Advisory · Propose / `--out` / `--apply` · Override Fragment Semantics (sequence-replace, full-list emission) · YAML Anchor Refusals · Reformat Acknowledgement · Idempotency · Machine Result Contract · Exit Codes · Limitations · Related Documentation                                                                                                                  |

### 5.4 Indexing and table updates

| File                                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/README.md` `:48-79` (`**CLI Features:**`)      | two entries in the two-line wrapped style, near the `rfapps Drift Command` / `rfapps Native Backup` peers                                                                                                                                                                                                                                                                                                           |
| `docs/README.md` `:317-332` (rfapps command table)   | one row — command `rfapps harden`, description "Propose or apply compose security hardening", confirmation "Apply only". Scanning is a flag on `plan`/`deploy`, not a command, so it gets no row.                                                                                                                                                                                                                   |
| `README.md` `:234-256` (`### Feature Documentation`) | both `docs/features/…` paths                                                                                                                                                                                                                                                                                                                                                                                        |
| `P/README.md`                                        | new `### harden` section under `## Commands` (`:197`), beside `### audit` (`:697`); `--scan`/`--scanner`/`--scan-fail-on` documented under `### plan` (`:1180`) and `### deploy`; exit-code table rows; the `scan:` and `harden:` config blocks beside the `lint` block (`:1855-1877`)                                                                                                                              |
| `docs/features/shell-completion.md`                  | command list (`:120-121`) and per-command option blocks (`:141-216`)                                                                                                                                                                                                                                                                                                                                                |
| `docs/features/quick-reference.md`                   | `### Vulnerability Scanning` and `### Security Hardening` under `## Essential Commands` (model: `### Native Filesystem Backup`, `:149`); two `## Related Documentation` entries (`:452-470`)                                                                                                                                                                                                                        |
| `docs/features/rfapps-configuration.md`              | `scan:` and `harden:` in the complete YAML example (`:22-99`) and the `### Optional Fields` list (`:112-126`). No env-var table change (no `RFAPPS_SCAN_*`/`RFAPPS_HARDEN_*`).                                                                                                                                                                                                                                      |
| `rfapps.config.yaml`                                 | commented `scan:` and `harden:` blocks after the `lint:` block (`:163-168`)                                                                                                                                                                                                                                                                                                                                         |
| `P/CLAUDE.md`                                        | add `harden.ts` to the `src/actions/` tree listing (`:44`); one `## Architecture Patterns` subsection per feature (model: the backup subsection at `:255-285`), each ending with a pointer to its feature doc; record the two invariants — _the scan lives on the plan output envelope, never on `DeploymentPlan`_ and _no harden patch may target a YAML alias or use a nested path_ — plus the MCP note from §5.2 |
| `ROADMAP.md`                                         | `:8` Last updated; `:10` Open issues 81 → 79 (rfapps 38 → 36); `:37` drop "#161 / #162" from the Current focus paragraph; `:49-58` close the Sprint 1 row and exit criteria; `:111-112` remove both medium-backlog rows and decrement the section count                                                                                                                                                             |
| `docs/roadmap-archive.md`                            | shipped entries for #161 and #162, matching the #295–#298 format                                                                                                                                                                                                                                                                                                                                                    |
| root `CLAUDE.md`                                     | **no change** — the Topic/Location table (`:242-252`) is curated and already omits drift/audit/doctor/backup                                                                                                                                                                                                                                                                                                        |

---

## 6. Test plan

CI for this package is only `npm ci` → `npm run build -w packages/rf-common` → `tsc --noEmit` → `vitest run --coverage` (`.github/workflows/rfapps-cli.yml:38-47`). There is no lint gate, no architecture gate, and no coverage threshold, and the `push` trigger targets `main` while the default branch is `master` — **PR CI is the only automated gate.** Tests must be chosen accordingly. Test files must live under `P/src/**` and end in `.spec.ts` or `.test.ts` (`P/vitest.config.ts:8`) or they silently never run.

### 6.1 Required

1. **`P/src/lib/security-scan.spec.ts` (new)** — trivy and grype fixture parsing (one realistic report each, plus `""`, `"{}"`, `{"Results":"nope"}`, and an entry with an unrecognised `Severity`); `MAX_RETAINED_PER_TARGET` truncation sets `truncated` while `counts` stays complete; `evaluateScanGate` at the exact severity boundary, with `failOn: "none"` never blocking even with criticals, and a single `failed` target producing `inconclusive`/`blocking: true`; suppression matching plus the expired-`until` note; `resolveScanTargets` classifying build-only, no-image, duplicate-image (with `scannedBy`), and target-cap.
   _Justification: this module is the sole normalizer of untrusted external JSON and the sole decider of whether a deploy proceeds. A severity-map or gate bug silently disables the security feature while every other test stays green._ Built entirely on injected `SecurityScanDependencies` (the `P/src/lib/backup-docker.spec.ts:66-100` factory pattern) — no `node:child_process` mocking.

2. **`P/src/lib/security-scan.spec.ts` — degradation cases in the same file** — missing binary ⇒ every target `scanner-unavailable` with the install hint and **zero** `runScanner` calls; `stderr: "Command timed out"` ⇒ `timeout`; `stderr: "Command output exceeded capture limit"` ⇒ `output-limit`; one target erroring while another succeeds ⇒ mixed `images` with accurate `targetsFailed`; and an assertion that `runScanner` received `tool: "none"`.
   _Justification: the exact sentinel-string matches are invisible to `tsc`, and the `tool: "none"` assertion is the only mechanical guard that a future refactor does not hand decrypted secrets to a third-party binary._

3. **`P/src/lib/hardening.spec.ts` (new)** — against a fixture compose string using `x-service-base`/`<<: *service-base` and `logging: *logging-default`: the `harden-log-rotation` patch yields `HardenRefusal{ code: "alias-target" }` **and the anchor definition block is byte-unchanged**; a top-level `merge-unique security_opt` on the same anchor-merged service applies and preserves `<<:`; `merge-unique` on a service already carrying `cap_drop: [ALL]` produces no duplicate; a scalar where a sequence was expected yields `unexpected-node` rather than a clobber; an absent service yields `service-missing`; `buildHardenOverride` emits the **full union** rather than only the added entry; `detectReformat` returns `wouldReformat: true` with a positive `lineDelta` for a source containing a multi-line flow sequence and `false` for a canonical source.
   _Justification: this is the only code in either issue that writes the operator's `compose.yml`, and the alias case is the one bug class that could reconfigure 42 services in one command._

4. **`P/src/lib/hardening.spec.ts` — rule-catalog property table in the same file** — ids unique; every `patches` entry declares a single-segment `key` (the nested-path invariant) and supplies an array `value` for `merge-unique`; every `advisory` rule has `patches: []`; and **idempotence**: for each rule, applying its own `propose()` output to a fixture service and re-running `detect()` returns `undefined`.
   _Justification: idempotence is load-bearing (`--apply` twice must be a no-op) and is the reason `merge-unique` exists; one table covers all nine rules and every future rule for free._

5. **`P/src/actions/deploy.spec.ts` (extend, 2 cases)** — (a) a blocking scan pushes `{ name: "scan", code: "VULNERABILITY_THRESHOLD" }` into `result.failed`, sets `process.exitCode === 1`, and calls neither `pullImages` nor `startServices`; (b) `--dry-run --scan` with a would-block gate exits 0 and still emits the report.
   _Justification: (a) is the only proof that the gate cannot be bypassed and cannot mutate — the core safety claim, and the ordering inside `executeDeploy` is invisible to the lib spec. (b) pins the deliberate dry-run-always-succeeds decision so a future contributor does not "fix" it._ Uses the file's existing `vi.mock("../lib/index.js", importOriginal)` pattern.

6. **`P/src/actions/harden.spec.ts` (new, 4 cases)** — propose mode issues zero `writeFile`/`copyFile` calls; `--apply` with `confirm` mocked to `false` issues zero writes; `--apply` together with `--out` throws `InvalidArgumentError`; a `review` proposal appears in `result.proposals` but not in `override`/`applied` without `--include-review`.
   _Justification: "default to non-destructive propose mode" is #162's headline requirement, and these four assertions are the only place it is mechanically verified._

7. **`P/src/actions/completion.spec.ts` (extend)** — widen the two command unions to include `"plan"` and `"harden"`, add the parity cases, add `"harden"` to the hardcoded list at `:362-390`.
   _Justification: not new coverage — the existing `deploy` parity test spawns the real CLI and does exact option-set equality, so it fails the moment `--scan` lands. Widening the union is the only mechanism in this repo that catches completion drift for `plan` and for a brand-new command._

### 6.2 Deliberately not written

- **`P/src/commands/harden.spec.ts` option-registration spec.** Commander wiring is declarative and the option set is already asserted from Commander itself by the parity test (6.1 #7); `validateHardenOptions` is exercised through the action spec. `backup.spec.ts` exists only because `backup` does command-level _value_ validation, which harden does not.
- **`P/src/actions/plan.spec.ts` scan case.** Plan's gate is the same `shouldBlock`/`gate.blocking` predicate covered in 6.1 #1, plan has no mutation to protect, and the only extra behaviour is a two-line early return that suppresses `--apply`.
- **`P/src/lib/exit-codes.spec.ts` cases for the two new resolvers.** Both are one-line boolean maps over `gate.blocking` / `refusals.length`; a test would assert `?:`.
- **Snapshot / golden tests for `formatScanText`, `formatHardenText`, `formatHardenRulesCatalog`.** Pure presentational string assembly with no invariant; a snapshot converts every wording improvement into a test edit and trains contributors to run `-u`. `formatAuditText` has no snapshot spec either.
- **Config merge/default specs for the new `scan:` and `harden:` sections.** `mergeConfig` and `partialToFull` are mechanical `??` chains copied verbatim from the shipped `lint:` precedent, and `config.test.ts` already covers the merge machinery. Both sections are optional, so the `makeConfig()` fixture at `P/src/lib/config-helpers.spec.ts:12-31` needs no change.
- **`packages/rf-common/src/env-tools.spec.ts` coverage for `checkExternalTool`.** Six lines delegating to the already-covered private `commandExists`/`getCommandVersion`; its only interesting behaviour (returning `installHint` as `error`) is asserted indirectly by 6.1 #2's `scanner-unavailable` case.
- **`P/src/cli.harden.integration.spec.ts` / `cli.plan.scan.integration.spec.ts`.** Spawning the real CLI costs seconds-to-minutes per case against the pre-push hook's 10-minute budget, needs a Docker daemon for `getComposeConfig`, and is where this repo's env-sensitivity bugs (`FORCE_COLOR`, `umask`) surface. The unit layer covers the same ground deterministically; `scan` takes no lock and `harden --apply`'s write path is fully covered at the lib layer.
- **An MCP spec asserting `planInputSchema` rejects `{ scan: true }`.** Generic closed-object behaviour already covered by `packages/rf-common`'s schema tests. The real safeguard is not adding the field (§5.2) plus the `P/CLAUDE.md` note.
- **`P/src/lib/lint.spec.ts` edits.** None are needed, by design: `LINT_RULES` is not touched.

---

## 7. Ordered implementation task list

No two tasks in the same wave own the same file. Every file appears under exactly one owner.

### Wave 0 — foundation (must land first)

**T0. rf-common tool probe**
Owns: `packages/rf-common/src/env-tools.ts`, `packages/rf-common/src/index.ts`.
Adds `checkExternalTool`. Depends on nothing. After this, run `npm run build -w packages/rf-common` once — every downstream typecheck needs the fresh `dist`.

### Wave 1 — pure cores (parallel, both depend on T0 for types only; #162's does not depend on T0 at all)

**T1. Scan types + engine (#161)**
Owns: `P/src/types/security-scan.ts`, `P/src/lib/security-scan.ts`, `P/src/lib/security-scan.spec.ts`.
Depends on: T0.
Delivers §3.1–§3.3 and §3.5, plus test items 6.1 #1 and #2.

**T2. Harden types + engine (#162)**
Owns: `P/src/types/hardening.ts`, `P/src/lib/hardening.ts`, `P/src/lib/hardening.spec.ts`.
Depends on: nothing.
Delivers §4.3–§4.5 and §4.9's renderers, plus test items 6.1 #3 and #4.

### Wave 2 — shared registries (sequential; one task, because these files are shared)

**T3. Barrels, config, exit codes**
Owns: `P/src/types/index.ts`, `P/src/lib/index.ts`, `P/src/types/config.ts`, `P/src/lib/config.ts`, `P/src/lib/exit-codes.ts`, `P/src/types/results.ts`.
Depends on: T1, T2.
Adds both `export *`/named barrel entries, the `scan:` and `harden:` config sections with their `mergeConfig`/`partialToFull` branches, `resolveScanExitCode`/`setScanExitCode`, `resolveHardenExitCode`/`setHardenExitCode`, and `DeployResult.scan?`.

### Wave 3 — hosts (parallel)

**T4. Plan + deploy integration (#161)**
Owns: `P/src/actions/plan.ts`, `P/src/actions/deploy.ts`, `P/src/actions/deploy.spec.ts`.
Depends on: T3.
Delivers §3.6, §3.7, and test item 6.1 #5.

**T5. Harden command + action (#162)**
Owns: `P/src/commands/harden.ts`, `P/src/actions/harden.ts`, `P/src/actions/harden.spec.ts`.
Depends on: T3.
Delivers §4.7 (registrar only), §4.8, and test item 6.1 #6.

### Wave 4 — CLI wiring (sequential; single owner of `cli.ts`)

**T6. `cli.ts`**
Owns: `P/src/cli.ts`.
Depends on: T4, T5.
Adds the three scan flags to the inline `plan` and `deploy` blocks, `plan`'s new `addHelpText`, `deploy`'s help-text paragraph, the `registerHardenCommand` import and call, the `harden` `preAction` validation case, and the `harden` branch in `resolveStateLockOperation`.

### Wave 5 — completion (sequential; must follow T6 so the parity test reads the real option sets)

**T7. Completion templates + parity tests**
Owns: `P/src/actions/completion.ts`, `P/src/actions/completion.spec.ts`.
Depends on: T6.
Delivers §5.1 and test item 6.1 #7.

### Wave 6 — docs and config sample (parallel with each other, after T6)

**T8. Feature docs**
Owns: `docs/features/rfapps-vulnerability-scanning.md`, `docs/features/rfapps-harden-command.md`.

**T9. Indexes and tables**
Owns: `docs/README.md`, `README.md`, `P/README.md`, `docs/features/shell-completion.md`, `docs/features/quick-reference.md`, `docs/features/rfapps-configuration.md`, `rfapps.config.yaml`, `P/CLAUDE.md`.
Depends on: T8 (for the filenames it links).

**T10. Roadmap**
Owns: `ROADMAP.md`, `docs/roadmap-archive.md`.

### Wave 7 — gates

**T11. Verification**
Owns: nothing.
Run, under `umask 022` and with `FORCE_COLOR` unset:

```
env -u FORCE_COLOR npm ci
env -u FORCE_COLOR npm run build -w packages/rf-common
env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli
env -u FORCE_COLOR npm run test:coverage --workspace packages/rfapps-cli
env -u FORCE_COLOR npm run test:run
env -u FORCE_COLOR npm run lint:md
env -u FORCE_COLOR npm run format:check
```

`FORCE_COLOR` breaks two `rf-common` logger tests and blocks `git push` via the pre-push hook; `umask 002` breaks a filesystem test in `rfapps-cli` independently of this change. A fresh worktree needs the `npm ci` bootstrap once, serially, before any gate will pass.

---

## 8. Open questions

**None.** Every decision that could have been deferred has been made above, including the two the judges split on (the `--scan-fail-on` default, and how to handle lossy YAML round-tripping). Two items were verified empirically against this repo rather than assumed, and their measurements are recorded in §4.2 so a reviewer can re-run them:

- `yaml`'s `setIn` through an alias node **throws** (`Expected YAML collection at logging. Remaining path: options,max-size`); it does not silently corrupt. The design guards it anyway, because an uncaught throw out of a pure module is still a defect.
- `parseDocument(compose.yml).toString({ lineWidth: 0, flowCollectionPadding: false })` differs from the source by exactly one hunk. If the `authentik-server.healthcheck.test` flow sequence is ever reflowed onto one line, `--apply` will stop needing `--allow-reformat` on this repo — a nice-to-have, not a prerequisite.
