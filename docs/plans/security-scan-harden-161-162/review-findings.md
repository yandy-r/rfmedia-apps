All findings verified against the code; hardening, settings, and CSV-bypass fixes were prototyped in scratch copies, executed, typechecked, and the scratch files removed (`git status` clean).

# PR #300 review report — ranked findings and minimal fixes

**Dedup note:** findings 1/9/12/15/19 are one defect (`scan.failOn`); findings 4/5 share one root cause and one fix; findings 2/11 and 13/16 are each one defect reported twice. 12 distinct defects follow.

---

## 1. [high] `harden --apply --output csv` rewrites compose.yml with no prompt and no `--yes`

`packages/rfapps-cli/src/commands/harden.ts:27`

Reproduced in `/tmp` (fixture compose, stdin closed): `--output csv --apply` → exit 0, compose.yml mutated with `security_opt`/`restart`/`logging`; `--output json --apply` correctly errors exit 2. `isMachineOutput` says csv is _not_ machine (so the `--yes` guard is skipped) while `isMachineFormat` in `actions/harden.ts:307` says csv _is_ machine (so the prompt is skipped). Severity corrected from critical → high: the default `.bak` copy makes it recoverable, but `--no-backup` is legal with `--apply`.

```ts
// packages/rfapps-cli/src/commands/harden.ts — add to the existing import block
import { isMachineFormat } from "@rfmedia/common";

// replace isMachineOutput (lines 27-30)
function isMachineOutput(options: RawHardenOptions, globalOptions: HardenGlobalOptions): boolean {
  // Must mirror resolveHardenFormat + isMachineFormat in actions/harden.ts: the
  // action skips the confirmation prompt for every machine format, csv included.
  if (options.json === true) {
    return true;
  }
  const format = globalOptions.output ?? (globalOptions.json === true ? "json" : "text");
  return isMachineFormat(format);
}
```

```ts
// same file, line 71 call site
  if (options.apply === true && isMachineOutput(options, globalOptions) && globalOptions.yes !== true) {
```

---

## 2. [high] Config-supplied `scan.failOn` is unvalidated — the vulnerability gate silently fails open

`packages/rfapps-cli/src/lib/security-scan-settings.ts:149`

`SCAN_SEVERITY_RANK["HIGH"]` is `undefined`, so every `rank >= undefined` is false and `evaluateScanGate` returns `passed`/`blocking:false` on a critical CVE, while printing `Gate: --scan-fail-on HIGH -> PASSED`. `scanner`, `ignore`, `timeoutMs`, `maxTargets`, `concurrency` are all validated in the same function; `failOn` is the only gap, and it is the one that fails open.

```ts
// replace line 149 and the `failOn,` return field
  let failOn = parseScanFailOn(raw.scanFailOn);
  if (failOn === undefined && configured?.failOn !== undefined) {
    // Same reason as scan.scanner above. An unrecognized threshold makes
    // SCAN_SEVERITY_RANK[failOn] undefined in evaluateScanGate, so every
    // comparison is false and the gate passes on any finding.
    if (!VALID_FAIL_ON.includes(configured.failOn)) {
      throw new InvalidArgumentError(
        "scan.failOn",
        String(configured.failOn),
        "Invalid scan severity threshold",
        [...VALID_FAIL_ON],
      );
    }
    failOn = configured.failOn;
  }
  return {
    scanner,
    failOn: failOn ?? DEFAULT_FAIL_ON,
```

Verified: `"HIGH"`/`"hgih"`/`" critical "` now throw `Invalid value '…' for scan.failOn`; `"critical"` → `critical`; flag still wins (`--scan-fail-on HIGH` + config `low` → `high`); no config → `none`. `tsc -p packages/rfapps-cli` clean.

---

## 3. [high] Anchor guard covers only the alias side: patching one service rewrites every sharer, and `set` on an anchored node crashes propose mode

`packages/rfapps-cli/src/lib/hardening.ts:314` (subsumes findings 4 and 5 — one fix)

`isAlias(existing)` catches the _consumer_ of an anchor, never the _producer_. Reproduced with the real exports: (a) `alpha.security_opt: &secopt` + `beta: *secopt`, targets `["alpha"]` → `refusals: []`, untargeted `beta` silently gains the entry; (b) `alpha: &alphaSvc` + `beta: {<<: *alphaSvc}` → `restart` written inside the anchored block; (c) `set` over an anchored node orphans the surviving alias and `serializeComposeDocument` throws `Unresolved alias …`, escaping the "never throws out of the patch path" contract and killing read-only propose mode and `--out`.

```ts
// hardening.ts:12 — extend the yaml import
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, stringify, visit, type Document } from "yaml";
```

```ts
// hardening.ts — insert above `function applyPatch` (line 285) and change its signature
/** Anchor names some alias elsewhere in the document resolves to. */
function referencedAnchors(doc: Document): ReadonlySet<string> {
  const names = new Set<string>();
  visit(doc, {
    Alias: (_key, node) => {
      names.add(node.source);
    },
  });
  return names;
}

/** The shared anchor carried by `node`, if any. An unreferenced anchor is safe. */
function sharedAnchorOn(node: unknown, shared: ReadonlySet<string>): string | undefined {
  if (!isNode(node) || isAlias(node)) {
    return undefined;
  }
  const anchor = node.anchor;
  return anchor !== undefined && shared.has(anchor) ? anchor : undefined;
}

function applyPatch(
  doc: Document,
  shared: ReadonlySet<string>,
  proposal: HardenProposal,
  patch: HardenPatch,
): HardenRefusal | undefined {
```

```ts
// hardening.ts — insert immediately after the existing isAlias(existing) refusal (after line 321)
// The guard above covers the alias side. This covers the anchor side: writing
// into a node other services alias or `<<:`-merge reconfigures every sharer,
// and replacing an anchored node orphans the aliases that still point at it.
const anchor =
  sharedAnchorOn(existing, shared) ??
  sharedAnchorOn(doc.getIn(["services", service], true), shared) ??
  sharedAnchorOn(doc.get("services", true), shared);
if (anchor !== undefined) {
  return refusalFor(
    "alias-target",
    proposal,
    `services.${service}.${patch.key} is inside the anchored node &${anchor}; editing it would change every service that shares the anchor`,
    `use: rfapps harden --rule ${proposal.ruleId} --out compose.harden.yaml`,
  );
}
```

```ts
// hardening.ts:401-407 — compute once, pass into applyPatch
  const refusals: HardenRefusal[] = [];
  const patched = new Set<string>();
  const shared = referencedAnchors(doc);
  let patchesWritten = 0;

  for (const proposal of proposals) {
    for (const patch of proposal.patches) {
      const refusal = applyPatch(doc, shared, proposal, patch);
```

Verified on the fixtures above: all three cases now return a refusal with the source byte-identical and **no throw**; an unreferenced anchor (`delta: &unused`) still patches; regression run over this repo's real `compose.yml` (45 services × 3 patch kinds) gives identical output and **0 new refusals** vs. master's applier.

---

## 4. [high] `harden-log-rotation` is `safe`-confidence but replaces the whole `logging` block, destroying driver and options

`packages/rfapps-cli/src/lib/hardening-rules.ts:139-147`

`detect` only checks `options["max-size"]`, `propose` ignores the service and emits a hardcoded full map, and `set` overwrites wholesale — reproduced: `driver: syslog` + `syslog-address` + `tag` + `max-file: "9"` → rewritten to bare json-file, no refusal, no `--include-review` needed. (The `--out` second-order claim in the finding does not reproduce; Compose discards base `logging.options` when the override changes driver. Only `--apply` is defective.)

```ts
// hardening-rules.ts — beside DEFAULT_RESTART (line 37)
/** Drivers whose options include max-size; any other driver rotates elsewhere. */
const ROTATION_CAPABLE_DRIVERS = new Set(["json-file", "local"]);
```

```ts
// hardening-rules.ts — replace the detect/propose pair of harden-log-rotation (lines 134-147)
    detect: (service) => {
      if (isPresent(service.logging?.options?.["max-size"])) {
        return undefined;
      }
      const evidence = ["logging.options.max-size is absent or empty"];
      const driver = service.logging?.driver;
      // max-size is a json-file/local option. On any other driver the rotation
      // patch cannot be written without changing where logs go.
      if (driver !== undefined && !ROTATION_CAPABLE_DRIVERS.has(driver)) {
        return {
          evidence,
          note: `logging.driver is "${driver}", which has no max-size option; configure rotation at the driver instead`,
          confidence: "advisory",
        };
      }
      return { evidence };
    },
    // Rebuilt from the resolved block: `set` replaces the whole logging map, so
    // any driver or option not carried here would be silently dropped.
    propose: (service) => {
      const existingDriver = service.logging?.driver;
      if (existingDriver !== undefined && !ROTATION_CAPABLE_DRIVERS.has(existingDriver)) {
        return []; // advisory: only the operator knows how this driver rotates.
      }
      const options: Record<string, string> = {
        ...(service.logging?.options ?? {}),
        "max-size": "10m",
      };
      options["max-file"] ??= "3";
      const driver = existingDriver ?? "json-file";
      const rendered = Object.entries(options)
        .map(([key, value]) => `${key}: "${value}"`)
        .join(", ");
      return [
        {
          key: "logging",
          operation: "set",
          value: { driver, options },
          description: `logging = { driver: "${driver}", options: { ${rendered} } }`,
        },
      ];
    },
```

Verified: bare service → patch byte-identical to today (so `actions/harden.spec.ts:76` still passes); `syslog` → advisory, zero patches; `json-file` with `tag`/`max-file: "9"` → both preserved, only `max-size` added; `local` → safe.

---

## 5. [medium] `--scanner` / `--scan-fail-on` without `--scan` are silently ignored (and unvalidated)

`packages/rfapps-cli/src/actions/deploy.ts:483`, `packages/rfapps-cli/src/actions/plan.ts:491`

Reproduced: `deploy -s traefik --dry-run --yes --scan-fail-on bogus --scanner nosuchscanner` → exit 0, no diagnostic; the same values _with_ `--scan` exit 2. Mirrors the `--batch-size`-without-`--staged` guard 170 lines earlier in the same file.

```ts
// deploy.ts — insert immediately after the existing staged-options guard (after line 319)
if (!options.scan && (rawOptions.scanner !== undefined || rawOptions.scanFailOn !== undefined)) {
  // Report the flag the operator actually typed.
  const suppliedFlag = rawOptions.scanner !== undefined ? "--scanner" : "--scan-fail-on";
  throw new InvalidArgumentError(
    suppliedFlag,
    String(rawOptions.scanner ?? rawOptions.scanFailOn),
    "Scan options require --scan",
  );
}
```

```ts
// plan.ts:45 — widen the errors import
import { DockerCommandError, InvalidArgumentError } from "../lib/errors.js";
```

```ts
// plan.ts — insert after `logDebug(\`Plan options: …\`);` (line 402)
if (!options.scan && (rawOptions.scanner !== undefined || rawOptions.scanFailOn !== undefined)) {
  const suppliedFlag = rawOptions.scanner !== undefined ? "--scanner" : "--scan-fail-on";
  throw new InvalidArgumentError(
    suppliedFlag,
    String(rawOptions.scanner ?? rawOptions.scanFailOn),
    "Scan options require --scan",
  );
}
```

`docs/features/rfapps-vulnerability-scanning.md:56-57` ("`--scan-fail-on` implies nothing on its own") needs its wording changed to "is a usage error without `--scan`".

---

## 6. [medium] `harden --apply` rewrites compose.yml non-atomically

`packages/rfapps-cli/src/actions/harden.ts:321`

`writeFile` opens the live compose.yml with `O_TRUNC`; ENOSPC/EIO/SIGINT/OOM after the truncate leaves a half-written file (reproduced under `ulimit -f`: 8192-byte compose.yml that no longer parses, and with `--no-backup` there is no recovery copy). `lib/state-rebuild-files.ts:181` and `lib/plan-storage.ts:1263` already establish temp+`rename` for in-place replacement.

```ts
// harden.ts:9 — widen the fs import
import { chmod, copyFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
```

```ts
// harden.ts — replace lines 316-331
const backupPath = `${composePath}.bak`;
const tempPath = `${composePath}.harden.tmp`;
try {
  if (backup) {
    await copyFile(composePath, backupPath);
  }
  // rename() within one directory is atomic, so compose.yml is either the
  // original or the fully patched file and never a truncated mix.
  const { mode } = await stat(composePath);
  await writeFile(tempPath, patched.content, "utf8");
  await chmod(tempPath, mode);
  await rename(tempPath, composePath);
} catch (error) {
  await rm(tempPath, { force: true });
  const message = error instanceof Error ? error.message : String(error);
  outputFormattedError(
    formatError(
      new DockerCommandError(
        "harden",
        `${message}; ${composePath} was not modified`,
        1,
        [...patched.servicesPatched],
        false,
      ),
    ),
  );
  setExitCode(ExitCode.OperationalError);
  return;
}
```

---

## 7. [medium] `deploy --dry-run --scan --output csv` crashes instead of stripping the report

`packages/rfapps-cli/src/actions/deploy.ts:615`

The dry-run payload guards `scan` on `table` only; `deployResultForOutput` (line 207) and `planResultForOutput` (plan.ts:133) both use `table || csv`. `ScanReport.scanner` is depth 2, so `formatAsCsv` throws (`MAX_DEPTH = 2`), exit 1 with no CSV — while the same command without `--dry-run` succeeds. Contradicts README:1033-1036 and `docs/features/json-output.md:163`.

```ts
// deploy.ts:615
        ...(result.scan === undefined || format === "table" || format === "csv"
          ? {}
          : { scan: result.scan }),
```

---

## 8. [low] `harden --apply` refuses on reformat before the dry-run and no-op branches

`packages/rfapps-cli/src/actions/harden.ts:289`

`detectReformat(compose.yml)` on this repo is `{wouldReformat: true, lineDelta: -6}`, so `rfapps --dry-run harden --apply --yes` exits 2 with a usage error against `docs/features/rfapps-harden-command.md:63` ("--dry-run … exits 0"), and a fully-hardened re-run (`writable.length === 0`) exits 2 for a write it would never perform. The informational `Note:` line is emitted by `formatHardenText` in every mode, so churn is still disclosed after the move.

```ts
// harden.ts — delete lines 289-295 and re-insert as the first statement of the write branch (line 306 `} else {`)
    } else {
      if (reformat.wouldReformat && !options.allowReformat) {
        throw new InvalidArgumentError(
          "--apply",
          "true",
          `writing compose.yml would also reformat lines this command did not target (line delta: ${reformat.lineDelta}); re-run with --allow-reformat to accept, or use --out for a non-destructive override`,
        );
      }
      if (!options.yes && !isMachineFormat(format)) {
```

---

## 9. [low] `plan --scan --output table` exits 1 with no scan output at all

`packages/rfapps-cli/src/actions/plan.ts:542-546`

`planResultForOutput` strips `scan` for `table`, and `formatScanText` runs only in the `text` branch, yet `setScanExitCode` still fires. `executeDeploy` prints it for `text || table` (deploy.ts:511). Hoisting the loop out of the `else` preserves text ordering exactly (it is currently the last statement there).

```ts
// plan.ts — delete lines 542-546 from the else branch, and insert after the closing `}` on line 547
if (scan !== undefined && (format === "text" || format === "table")) {
  for (const line of formatScanText(scan)) {
    console.error(line);
  }
}
```

---

## 10. [low] `merge-unique` dedup is blind to alias items, appending a literal duplicate

`packages/rfapps-cli/src/lib/hardening.ts:350`

`security_opt: [- *sec]` where `&sec` is `seccomp=unconfined` → patch value carries the full resolved union, `present` maps the Alias item to `undefined`, and the value is appended literally, decoupling the service from the anchor.

```ts
// hardening.ts:350-352
const present = new Set(
  existing.items.map((item) => {
    // An alias item already supplies its anchor's value; treating it as
    // unknown appends a literal duplicate of what it resolves to.
    const resolved = isAlias(item) ? item.resolve(doc) : item;
    return isScalar(resolved) ? String(resolved.value) : undefined;
  }),
);
```

Verified: fixture now yields `- *sec` + `- no-new-privileges:true` only.

---

## 11. [low] Alias refusal prints the literal `(*anchor)` instead of the anchor name

`packages/rfapps-cli/src/lib/hardening.ts:318`

`docs/features/rfapps-harden-command.md:202,357` and `docs/features/json-output.md:601` all document `(*logging-default)` — a string no invocation can currently emit.

```ts
// hardening.ts:318
      `services.${service}.${patch.key} is a YAML alias (*${existing.source}); editing it would change every service that shares the anchor`,
```

Verified output: `services.sonarr.logging is a YAML alias (*logging-default); …`. `hardening.spec.ts:103` asserts only `code/service/ruleId`, so no spec change is forced (adding a `detail` assertion is worthwhile).

---

## 12. [low] Zero-target scan reports the scanner as unavailable although it was never probed

`packages/rfapps-cli/src/lib/security-scan.ts:340`

`rfapps plan -s lidarr --scan` (build-only service) prints `Scanner: trivy (unavailable)` and emits `"available": false` on a host where trivy is installed. Gate and exit code are unaffected — reporting only.

```ts
// security-scan.ts — add an else to the `if (targets.length > 0)` block (after line 362)
  } else {
    notes.push(
      `no scannable targets, so ${backend.binary} was not probed; "available: false" means "not checked" here`,
    );
  }
```

---

## Fixes touching the same file (assign one agent each)

| File                                                    | Findings                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/hardening.ts`              | 3 (anchor guard), 10 (alias-item dedup), 11 (anchor name) — all inside `applyPatch`/`applyHardenPatches`; apply together, single yaml import edit |
| `packages/rfapps-cli/src/actions/harden.ts`             | 6 (atomic write), 8 (reformat ordering) — adjacent lines 289-331; must be applied together to avoid a conflicting hunk                            |
| `packages/rfapps-cli/src/actions/deploy.ts`             | 5 (scan-flag guard, line ~320), 7 (csv strip, line 615) — non-adjacent, no conflict                                                               |
| `packages/rfapps-cli/src/actions/plan.ts`               | 5 (scan-flag guard, line ~402), 9 (table scan render, line 542) — non-adjacent, no conflict                                                       |
| `packages/rfapps-cli/src/commands/harden.ts`            | 1 only                                                                                                                                            |
| `packages/rfapps-cli/src/lib/security-scan-settings.ts` | 2 only                                                                                                                                            |
| `packages/rfapps-cli/src/lib/hardening-rules.ts`        | 4 only                                                                                                                                            |
| `packages/rfapps-cli/src/lib/security-scan.ts`          | 12 only                                                                                                                                           |

Cross-file coupling: fix 3 changes refusal wording for anchored nodes and fix 11 changes it for aliases; both land in `hardening.ts` and neither touches `hardening-rules.ts` (fix 4), so the two hardening files can be worked in parallel.

## Merge blocking

**Yes — findings 1, 2, 3, and 4 block merge.**

- 1: the destructive path writes the operator's compose.yml with neither confirmation nor `--yes`, in the exact case the guard's own error message claims is impossible.
- 2: the advertised fail-closed gate reports `PASSED` on critical CVEs whenever the threshold comes from `rfapps.config.yaml` in any non-canonical spelling.
- 3: a scoped `harden` run silently mutates untargeted services (and can strip capabilities under `--include-review`), and read-only propose mode crashes with a raw YAML error on legal compose input.
- 4: a `safe`-confidence default `--apply` destroys an operator's log driver and options.

Finding 5 is a strong should-fix before merge (a CI gate that never runs, exiting 0). Findings 6-12 can ship as follow-ups, though 6 and 7 are cheap and low-risk enough to include in the same pass.

New test coverage the fixes need (none exists today): `security-scan-settings.spec.ts` (config-sourced `failOn`), `hardening.spec.ts` cases for an anchored service key and an anchored service map plus an alias sequence item, an inline non-`json-file` `logging` case in the rules spec, and an `actions/harden.spec.ts` case asserting `{apply:true}` + `output:"csv"` throws and calls neither `confirm` nor `writeFile`.
