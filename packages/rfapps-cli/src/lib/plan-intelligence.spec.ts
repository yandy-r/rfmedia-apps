import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposeServiceConfig } from "./docker.js";

// Mirrors `dependency-graph.spec.ts`: the graph builder is the only Docker
// consumer reached from here, and its dependency extraction is pure.
vi.mock("./docker.js", () => ({
  getComposeConfig: vi.fn(),
  getComposeServiceDependencies: vi.fn((service: ComposeServiceConfig | undefined) => {
    if (service?.depends_on === undefined) {
      return [];
    }
    if (Array.isArray(service.depends_on)) {
      return service.depends_on;
    }
    return Object.keys(service.depends_on);
  }),
}));

import { buildPlanIntelligence, type PlanIntelligenceBuildInput } from "./plan-intelligence.js";
import { MAX_IMPACT_DEPENDENTS, MAX_REASON_EVIDENCE } from "../types/plan-intelligence.js";

import type {
  ChangeDimension,
  ChangeReason,
  ChangeReasonCode,
  PlanBaselineResult,
  PlanIntelligence,
  PlanProvenance,
  ReasonConfidence,
  ServiceIntelligence,
} from "../types/plan-intelligence.js";
import type { EnvChange, ImageDiff, ServiceChange } from "../types/plan.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);
const BASELINE_PLAN_ID = "8f3a2c11-1d4e-4a55-9f0b-2c7d3e5a1b90";

/**
 * A `ServiceChange` with every non-optional field populated.
 *
 * `ports`, `volumes`, and `networks` are not optional on `ServiceChange`: a
 * fixture missing one runs under `vitest` but fails the whole-package `tsc`.
 */
function makeChange(service: string, overrides: Partial<ServiceChange> = {}): ServiceChange {
  return {
    service,
    resolvedConfigFingerprint: FINGERPRINT_A,
    changeType: "unchanged",
    image: { changed: false },
    environment: [],
    ports: { changed: false },
    volumes: { changed: false },
    networks: { changed: false },
    ...overrides,
  };
}

function makeEnv(
  name: string,
  changeType: EnvChange["changeType"],
  overrides: Partial<EnvChange> = {},
): EnvChange {
  return { name, changeType, isSecret: false, ...overrides };
}

function makeInput(
  overrides: Partial<PlanIntelligenceBuildInput> = {},
): PlanIntelligenceBuildInput {
  return {
    services: [],
    decisiveByService: new Map<string, readonly ChangeDimension[]>(),
    composeServices: {},
    runningServices: new Set<string>(),
    runtimeStateObserved: true,
    registryChecked: false,
    profileMapping: {},
    baseline: { status: "unavailable", reason: "no-comparable-plan" },
    ...overrides,
  };
}

/** A compose model where each key lists the services it declares `depends_on`. */
function composeServices(graph: Record<string, string[]>): Record<string, ComposeServiceConfig> {
  return Object.fromEntries(
    Object.entries(graph).map(([name, dependsOn]) => [name, { name, depends_on: dependsOn }]),
  );
}

function loadedBaseline(
  fingerprints: Record<string, string>,
  composeFileChanged: boolean,
): PlanBaselineResult {
  return {
    status: "loaded",
    baseline: {
      planId: BASELINE_PLAN_ID,
      createdAt: "2026-07-28T09:14:02Z",
      composeFileChanged,
      services: Object.fromEntries(
        Object.entries(fingerprints).map(([name, resolvedConfigFingerprint]) => [
          name,
          { resolvedConfigFingerprint },
        ]),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Union-narrowing helpers. These THROW on the wrong variant so a wrong shape
// fails loudly instead of silently skipping the assertions that follow.
// ---------------------------------------------------------------------------

function requireService(intelligence: PlanIntelligence, service: string): ServiceIntelligence {
  const entry = intelligence.services[service];
  if (entry === undefined) {
    const present = Object.keys(intelligence.services).join(", ");
    throw new Error(`expected annotations for "${service}"; annotated: ${present || "none"}`);
  }
  return entry;
}

function requireReason(entry: ServiceIntelligence, code: ChangeReasonCode): ChangeReason {
  const reason = entry.reasons.find((candidate) => candidate.code === code);
  if (reason === undefined) {
    throw new Error(`expected reason "${code}"; received: ${codesOf(entry).join(", ") || "none"}`);
  }
  return reason;
}

function requirePreviousPlan(
  provenance: PlanProvenance,
): Extract<PlanProvenance, { baseline: "previous-plan" }> {
  if (provenance.baseline !== "previous-plan") {
    throw new Error(`expected a previous-plan provenance, received "${provenance.baseline}"`);
  }
  return provenance;
}

function codesOf(entry: ServiceIntelligence): ChangeReasonCode[] {
  return entry.reasons.map((reason) => reason.code);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// T1 -- trigger cascade
// ---------------------------------------------------------------------------

const DRIFTING_IMAGE: ImageDiff = {
  changed: false,
  current: "docker.io/linuxserver/radarr:5.4",
  desired: "docker.io/linuxserver/radarr:5.4",
  updateStatus: "update-available",
  canonicalImage: "docker.io/linuxserver/radarr:5.4",
  localDigest: "sha256:9c1f2e4a8b3d0000000000",
  remoteDigest: "sha256:31a0be77cc120000000000",
};

interface TriggerRow {
  label: string;
  change: ServiceChange;
  decisive: readonly ChangeDimension[];
  registryChecked: boolean;
  /** Empty means the service must be absent from `intelligence.services`. */
  expected: ReadonlyArray<{ code: ChangeReasonCode; decisive: boolean }>;
}

const triggerRows: readonly TriggerRow[] = [
  {
    label: "create emits only container-not-running, never the vacuous first-deploy diffs",
    change: makeChange("praxrr", {
      changeType: "create",
      image: { changed: true, desired: "praxrr:1.0" },
      environment: [makeEnv("TZ", "added")],
      ports: { changed: true, desired: [{ container: "80", protocol: "tcp" }] },
      volumes: { changed: true, desired: [{ source: "/data", target: "/data" }] },
      networks: { changed: true, desired: ["apps"] },
    }),
    decisive: ["runtime"],
    registryChecked: false,
    expected: [{ code: "container-not-running", decisive: true }],
  },
  {
    label: "recreate emits the decisive image trigger plus concurrent non-decisive dimensions",
    change: makeChange("plex", {
      changeType: "recreate",
      image: { changed: true, current: "plex:1.40.2", desired: "plex:1.41.0" },
      environment: [makeEnv("PLEX_CLAIM", "modified")],
      volumes: {
        changed: true,
        current: [{ source: "/old", target: "/config" }],
        desired: [{ source: "/new", target: "/config" }],
      },
    }),
    decisive: ["image"],
    registryChecked: false,
    expected: [
      { code: "image-reference-changed", decisive: true },
      { code: "environment-changed", decisive: false },
      { code: "volumes-changed", decisive: false },
    ],
  },
  {
    label: "update emits every changed dimension as decisive",
    change: makeChange("authentik-server", {
      changeType: "update",
      environment: [makeEnv("AUTHENTIK_SECRET_KEY", "modified")],
      ports: {
        changed: true,
        current: [{ host: "9000", container: "9000", protocol: "tcp" }],
        desired: [{ host: "9443", container: "9000", protocol: "tcp" }],
      },
    }),
    decisive: ["environment", "ports"],
    registryChecked: false,
    expected: [
      { code: "environment-changed", decisive: true },
      { code: "ports-changed", decisive: true },
    ],
  },
  {
    label: "unchanged service with update-available surfaces registry drift",
    change: makeChange("radarr", { image: DRIFTING_IMAGE }),
    decisive: [],
    registryChecked: true,
    expected: [{ code: "registry-image-drifted", decisive: false }],
  },
  {
    label: "unsupported (build-only) never renders as registry drift",
    change: makeChange("radarr", { image: { ...DRIFTING_IMAGE, updateStatus: "unsupported" } }),
    decisive: [],
    registryChecked: true,
    expected: [],
  },
  {
    label: "unknown never renders as registry drift",
    change: makeChange("radarr", { image: { ...DRIFTING_IMAGE, updateStatus: "unknown" } }),
    decisive: [],
    registryChecked: true,
    expected: [],
  },
  {
    label: "local-missing never renders as registry drift",
    change: makeChange("radarr", { image: { ...DRIFTING_IMAGE, updateStatus: "local-missing" } }),
    decisive: [],
    registryChecked: true,
    expected: [],
  },
  {
    label: "drift is not claimed when the registry was never checked",
    change: makeChange("radarr", { image: DRIFTING_IMAGE }),
    decisive: [],
    registryChecked: false,
    expected: [],
  },
  {
    label: "unchanged service with nothing to say is omitted entirely",
    change: makeChange("tautulli"),
    decisive: [],
    registryChecked: true,
    expected: [],
  },
];

describe("buildPlanIntelligence trigger cascade", () => {
  it.each(triggerRows)("$label", ({ change, decisive, registryChecked, expected }: TriggerRow) => {
    const intelligence = buildPlanIntelligence(
      makeInput({
        services: [change],
        decisiveByService: new Map([[change.service, decisive]]),
        composeServices: composeServices({ [change.service]: [] }),
        registryChecked,
      }),
    );

    if (expected.length === 0) {
      expect(intelligence.services[change.service]).toBeUndefined();
      expect(intelligence.summary.annotatedServices).toBe(0);
      return;
    }

    const entry = requireService(intelligence, change.service);
    expect(codesOf(entry)).toEqual(expected.map((reason) => reason.code));
    for (const { code, decisive: isDecisive } of expected) {
      expect(requireReason(entry, code).decisive).toBe(isDecisive);
    }
    expect(intelligence.summary.annotatedServices).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T2 -- provenance and degradation
// ---------------------------------------------------------------------------

interface ProvenanceRow {
  label: string;
  baseline: PlanBaselineResult;
  fingerprint: string;
  expectedBaseline: PlanProvenance["baseline"];
  expectedCode?: ChangeReasonCode;
  expectedConfidence?: ReasonConfidence;
  /** Defaults to a changing `update`; `unchanged` exercises the no-op path. */
  changeType?: ServiceChange["changeType"];
  image?: ImageDiff;
  registryChecked?: boolean;
  /** True when the service must be absent from `intelligence.services`. */
  omitted?: boolean;
  /** Every code on the entry, when the row constrains more than provenance. */
  expectedCodes?: readonly ChangeReasonCode[];
}

const provenanceRows: readonly ProvenanceRow[] = [
  {
    label: "no baseline yields no provenance reason and a `none` plan provenance",
    baseline: { status: "unavailable", reason: "no-comparable-plan" },
    fingerprint: FINGERPRINT_B,
    expectedBaseline: "none",
  },
  {
    label: "fingerprint moved with an edited compose file is inferred compose-file-edited",
    baseline: loadedBaseline({ plex: FINGERPRINT_A }, true),
    fingerprint: FINGERPRINT_B,
    expectedBaseline: "previous-plan",
    expectedCode: "compose-file-edited",
    expectedConfidence: "inferred",
  },
  {
    label: "fingerprint moved with an unchanged compose file is inferred resolved-config-changed",
    baseline: loadedBaseline({ plex: FINGERPRINT_A }, false),
    fingerprint: FINGERPRINT_B,
    expectedBaseline: "previous-plan",
    expectedCode: "resolved-config-changed",
    expectedConfidence: "inferred",
  },
  {
    label: "an equal fingerprint is confirmed unchanged-since-baseline",
    baseline: loadedBaseline({ plex: FINGERPRINT_A }, true),
    fingerprint: FINGERPRINT_A,
    expectedBaseline: "previous-plan",
    expectedCode: "unchanged-since-baseline",
    expectedConfidence: "confirmed",
  },
  {
    label: "a baseline that never saw this service yields no provenance reason",
    baseline: loadedBaseline({ sonarr: FINGERPRINT_A }, true),
    fingerprint: FINGERPRINT_B,
    expectedBaseline: "previous-plan",
  },
  {
    label: "a non-fingerprint baseline value yields no provenance reason",
    baseline: loadedBaseline({ plex: "legacy" }, true),
    fingerprint: FINGERPRINT_B,
    expectedBaseline: "previous-plan",
  },
  {
    label: "an unchanged service matching the baseline is omitted, never called already pending",
    baseline: loadedBaseline({ plex: FINGERPRINT_A }, true),
    fingerprint: FINGERPRINT_A,
    expectedBaseline: "previous-plan",
    changeType: "unchanged",
    omitted: true,
  },
  {
    label: "an unchanged service whose resolved config moved is still omitted",
    baseline: loadedBaseline({ plex: FINGERPRINT_A }, false),
    fingerprint: FINGERPRINT_B,
    expectedBaseline: "previous-plan",
    changeType: "unchanged",
    omitted: true,
  },
  {
    label: "registry drift stays reachable on an unchanged service, carrying no provenance",
    baseline: loadedBaseline({ plex: FINGERPRINT_A }, true),
    fingerprint: FINGERPRINT_A,
    expectedBaseline: "previous-plan",
    changeType: "unchanged",
    image: DRIFTING_IMAGE,
    registryChecked: true,
    expectedCodes: ["registry-image-drifted"],
  },
];

describe("buildPlanIntelligence provenance and degradation", () => {
  it.each(provenanceRows)(
    "$label",
    ({
      baseline,
      fingerprint,
      expectedBaseline,
      expectedCode,
      expectedConfidence,
      changeType = "update",
      image,
      registryChecked = false,
      omitted = false,
      expectedCodes,
    }: ProvenanceRow) => {
      const isChanging = changeType !== "unchanged";
      const change = makeChange("plex", {
        changeType,
        resolvedConfigFingerprint: fingerprint,
        ...(isChanging ? { environment: [makeEnv("TZ", "modified")] } : {}),
        ...(image === undefined ? {} : { image }),
      });

      const intelligence = buildPlanIntelligence(
        makeInput({
          services: [change],
          decisiveByService: new Map<string, readonly ChangeDimension[]>([
            ["plex", isChanging ? ["environment"] : []],
          ]),
          composeServices: composeServices({ plex: [] }),
          registryChecked,
          baseline,
        }),
      );

      expect(intelligence.provenance.baseline).toBe(expectedBaseline);
      if (expectedBaseline === "previous-plan") {
        expect(requirePreviousPlan(intelligence.provenance).planId).toBe(BASELINE_PLAN_ID);
      }

      // A no-op service carries no origin: it must not reach the plan file at all.
      if (omitted) {
        expect(intelligence.services["plex"]).toBeUndefined();
        expect(intelligence.summary.annotatedServices).toBe(0);
        expect(intelligence.summary.dominantReason).toBeUndefined();
        expect(JSON.stringify(intelligence)).not.toContain("unchanged-since-baseline");
        return;
      }

      const entry = requireService(intelligence, "plex");
      const provenanceCodes = entry.reasons
        .filter((reason) => reason.kind === "provenance")
        .map((reason) => reason.code);
      if (expectedCodes !== undefined) {
        expect(codesOf(entry)).toEqual([...expectedCodes]);
      }

      if (expectedCode === undefined) {
        expect(provenanceCodes).toEqual([]);
        return;
      }

      expect(provenanceCodes).toEqual([expectedCode]);
      const reason = requireReason(entry, expectedCode);
      expect(reason.confidence).toBe(expectedConfidence);
      expect(reason.decisive).toBe(false);
      expect(reason.evidence[0]).toContain("baseline plan");
    },
  );

  it("suppresses every container-not-running reason when runtime state was not observed", () => {
    const services = [
      makeChange("plex", { changeType: "create" }),
      makeChange("sonarr", { changeType: "create" }),
    ];

    const intelligence = buildPlanIntelligence(
      makeInput({
        services,
        decisiveByService: new Map([
          ["plex", ["runtime"] as const],
          ["sonarr", ["runtime"] as const],
        ]),
        composeServices: composeServices({ plex: [], sonarr: [] }),
        runtimeStateObserved: false,
      }),
    );

    expect(intelligence.runtimeStateObserved).toBe(false);
    expect(Object.keys(intelligence.services)).toEqual([]);
    expect(JSON.stringify(intelligence)).not.toContain("container-not-running");
  });
});

// ---------------------------------------------------------------------------
// T3 -- bounds, secret-freedom, and non-negative counters
// ---------------------------------------------------------------------------

const CANARY_CURRENT = "canary-plaintext-current-6f21ab";
const CANARY_DESIRED = "canary-plaintext-desired-90c4de";

describe("buildPlanIntelligence bounds, secret-freedom, and counters", () => {
  it("caps evidence and dependents while reporting true totals, and never copies a value", () => {
    const environment = [
      makeEnv("PLEX_CLAIM", "modified", {
        isSecret: true,
        current: CANARY_CURRENT,
        desired: CANARY_DESIRED,
      }),
      ...Array.from({ length: 29 }, (_unused, index) =>
        makeEnv(`VAR_${String(index).padStart(2, "0")}`, "modified", {
          current: "old",
          desired: "new",
        }),
      ),
    ];
    const dependents = Array.from(
      { length: 40 },
      (_unused, index) => `dep-${String(index).padStart(2, "0")}`,
    );

    const intelligence = buildPlanIntelligence(
      makeInput({
        services: [makeChange("plex", { changeType: "update", environment })],
        decisiveByService: new Map([["plex", ["environment"] as const]]),
        composeServices: composeServices({
          plex: [],
          ...Object.fromEntries(dependents.map((name) => [name, ["plex"]])),
        }),
        runningServices: new Set(dependents.slice(0, 7)),
      }),
    );

    const entry = requireService(intelligence, "plex");
    const reason = requireReason(entry, "environment-changed");
    expect(reason.evidence).toHaveLength(MAX_REASON_EVIDENCE);
    expect(reason.evidence.at(-1)).toBe("+25 more");
    expect(reason.evidence[0]).toBe("PLEX_CLAIM (modified)");

    expect(entry.impact.dependentCount).toBe(dependents.length);
    expect(entry.impact.dependents).toHaveLength(MAX_IMPACT_DEPENDENTS);
    expect(entry.impact.dependentsTruncated).toBe(true);
    expect(entry.impact.runningDependentCount).toBe(7);

    const serialized = JSON.stringify(intelligence);
    expect(serialized).not.toContain(CANARY_CURRENT);
    expect(serialized).not.toContain(CANARY_DESIRED);
  });

  it("computes downstreamImpacted as a set difference, so leaf-only plans report zero", () => {
    const intelligence = buildPlanIntelligence(
      makeInput({
        services: [
          makeChange("kometa", { changeType: "recreate", image: { changed: true } }),
          makeChange("tautulli", { changeType: "recreate", image: { changed: true } }),
        ],
        decisiveByService: new Map([
          ["kometa", ["image"] as const],
          ["tautulli", ["image"] as const],
        ]),
        composeServices: composeServices({ plex: [], kometa: ["plex"], tautulli: ["plex"] }),
      }),
    );

    expect(intelligence.summary.annotatedServices).toBe(2);
    expect(intelligence.summary.downstreamImpacted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T4 -- impact graph
// ---------------------------------------------------------------------------

describe("buildPlanIntelligence impact graph", () => {
  it("counts transitive and out-of-scope dependents, terminates on cycles, and maps effects", () => {
    const intelligence = buildPlanIntelligence(
      makeInput({
        services: [
          makeChange("db", { changeType: "recreate", image: { changed: true } }),
          makeChange("api", {
            changeType: "update",
            environment: [makeEnv("LOG_LEVEL", "modified")],
          }),
          makeChange("cycle-a", {
            changeType: "update",
            environment: [makeEnv("LOG_LEVEL", "modified")],
          }),
          makeChange("newbie", { changeType: "create" }),
          makeChange("cache", { image: DRIFTING_IMAGE }),
        ],
        decisiveByService: new Map([
          ["db", ["image"] as const],
          ["api", ["environment"] as const],
          ["cycle-a", ["environment"] as const],
          ["newbie", ["runtime"] as const],
        ]),
        composeServices: composeServices({
          db: [],
          api: ["db"],
          web: ["api"],
          worker: ["api"],
          outsider: ["db"],
          newbie: [],
          cache: [],
          "cycle-a": ["cycle-b"],
          "cycle-b": ["cycle-a"],
        }),
        runningServices: new Set(["api", "web", "cycle-b"]),
        registryChecked: true,
        profileMapping: { db: "core" },
      }),
    );

    // Transitive closure, seed excluded, including `outsider` which is not in
    // this plan's change set.
    const db = requireService(intelligence, "db");
    expect(db.impact.dependents).toEqual(["api", "outsider", "web", "worker"]);
    expect(db.impact.dependentCount).toBe(4);
    expect(db.impact.dependentsTruncated).toBe(false);
    expect(db.impact.runningDependentCount).toBe(2);
    expect(db.impact.effect).toBe("replace");
    expect(db.impact.critical).toBe(true);
    expect(db.impact.changingDependencies).toEqual([]);

    // Direct dependency that this plan also replaces.
    const api = requireService(intelligence, "api");
    expect(api.impact.dependents).toEqual(["web", "worker"]);
    expect(api.impact.changingDependencies).toEqual(["db"]);
    expect(api.impact.critical).toBe(false);

    // A `depends_on` cycle terminates and never reports the seed.
    const cycleA = requireService(intelligence, "cycle-a");
    expect(cycleA.impact.dependents).toEqual(["cycle-b"]);

    expect(requireService(intelligence, "newbie").impact.effect).toBe("create");

    const cache = requireService(intelligence, "cache");
    expect(cache.impact.effect).toBe("none");
    expect(cache.impact.dependentCount).toBe(0);

    expect(intelligence.summary.criticalServices).toBe(1);
  });
});
