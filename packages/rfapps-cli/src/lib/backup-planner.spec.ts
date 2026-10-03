import { describe, expect, it, vi } from "vitest";

import type {
  CanonicalComposeConfigEvidence,
  CanonicalComposeServiceConfig,
} from "./docker-conflict-evidence.js";
import {
  BackupPlannerError,
  planBackup,
  type BackupPlannerDependencies,
  type BackupPlannerInput,
} from "./backup-planner.js";
import type { BackupBindTopologyProbeResult, BackupSourceProbeResult } from "../types/backup.js";

const SHA256 = "a".repeat(64);

function service(
  name: string,
  volumes: CanonicalComposeServiceConfig["volumes"],
  dependsOn: readonly string[] = [],
): CanonicalComposeServiceConfig {
  return {
    name,
    depends_on: dependsOn,
    ports: [],
    volumes,
    networks: [],
  };
}

function evidence(
  services: Readonly<Record<string, CanonicalComposeServiceConfig>>,
): CanonicalComposeConfigEvidence {
  return {
    resolvedConfigFingerprint: SHA256,
    config: {
      name: "media",
      services,
      volumes: {
        data: { name: "media_data", driver: "local", external: false, driver_opts: {} },
      },
      networks: {},
    },
  };
}

function plannerInput(
  services: Readonly<Record<string, CanonicalComposeServiceConfig>>,
  overrides: Partial<BackupPlannerInput> = {},
): BackupPlannerInput {
  return {
    composeEvidence: evidence(services),
    requestedServices: ["app"],
    canonicalDestination: "/backup",
    dockerAuthorityFingerprint: "b".repeat(64),
    localDockerAuthority: true,
    ...overrides,
  };
}

function dependencies(
  probe: (sourcePath: string) => BackupSourceProbeResult = () => ({
    status: "available",
  }),
  topology: (sourcePaths: readonly string[]) => BackupBindTopologyProbeResult = (sourcePaths) => ({
    entries: sourcePaths.map((sourcePath) => ({
      sourcePath,
      majorMinor: "8:1",
      mountRoot: sourcePath,
    })),
    fingerprint: "c".repeat(64),
  }),
): BackupPlannerDependencies {
  return {
    probeSource: vi.fn(async (source) => probe(source.kind === "bind" ? source.path : source.name)),
    probeBindTopology: vi.fn(async (sourcePaths) => topology(sourcePaths)),
  };
}

async function expectPlannerError(
  input: BackupPlannerInput,
  deps: BackupPlannerDependencies,
  code: BackupPlannerError["code"],
): Promise<void> {
  try {
    await planBackup(input, deps);
    throw new Error("Expected backup planning to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BackupPlannerError);
    if (error instanceof BackupPlannerError) expect(error.code).toBe(code);
  }
}

describe("planBackup", () => {
  it("deduplicates exact sources, preserves all consumers, and quiesces full-project overlaps", async () => {
    const services = {
      app: service(
        "app",
        [
          { type: "bind", source: "/srv/data", target: "/data", read_only: false },
          { type: "volume", source: "data", target: "/db", read_only: false },
        ],
        ["database"],
      ),
      database: service("database", [
        { type: "volume", source: "data", target: "/var/lib/db", read_only: false },
      ]),
      reader: service("reader", [
        { type: "bind", source: "/srv/data", target: "/read", read_only: true },
      ]),
      parentWriter: service("parentWriter", [
        { type: "bind", source: "/srv", target: "/host", read_only: false },
      ]),
      childWriter: service("childWriter", [
        { type: "bind", source: "/srv/data/cache", target: "/cache", read_only: false },
      ]),
    };

    const deps = dependencies();
    const plan = await planBackup(plannerInput(services), deps);

    expect(plan.requestedServices).toEqual(["app"]);
    expect(plan.resolvedServices).toEqual(["app", "database"]);
    expect(plan.mounts.map((mount) => mount.source)).toEqual([
      { kind: "bind", path: "/srv/data" },
      { kind: "volume", name: "media_data", driver: "local", external: false },
    ]);
    expect(plan.mounts[0]?.consumers).toEqual([
      { service: "app", target: "/data", readOnly: false },
      { service: "reader", target: "/read", readOnly: true },
    ]);
    expect(plan.mounts[0]?.writerServices).toEqual(["app", "childWriter", "parentWriter"]);
    expect(plan.mounts[1]?.consumers).toEqual([
      { service: "app", target: "/db", readOnly: false },
      { service: "database", target: "/var/lib/db", readOnly: false },
    ]);
    expect(plan.quiescedServices).toEqual(["app", "childWriter", "database", "parentWriter"]);
    expect(plan.recoveryLayers).toEqual([["childWriter", "database", "parentWriter"], ["app"]]);
    expect(plan.mounts.map(({ id, artifactPath }) => ({ id, artifactPath }))).toEqual([
      { id: "mount-0001", artifactPath: "artifacts/mount-0001.tar.gz" },
      { id: "mount-0002", artifactPath: "artifacts/mount-0002.tar.gz" },
    ]);
    expect(deps.probeSource).toHaveBeenCalledTimes(2);
  });

  it("classifies approved intentional skips deterministically", async () => {
    const services = {
      app: service("app", [
        { type: "tmpfs", target: "/tmp", read_only: false },
        { type: "bind", source: "/proc", target: "/host-proc", read_only: false },
        { type: "bind", source: "/srv/docker.sock", target: "/docker.sock", read_only: false },
        { type: "bind", source: "/dev/dri", target: "/dev/dri", read_only: false },
        { type: "bind", source: "/etc/hosts", target: "/etc/hosts", read_only: true },
      ]),
    };
    const deps = dependencies((source) => {
      if (source.endsWith("docker.sock")) return { status: "not-directory", kind: "socket" };
      if (source === "/dev/dri") return { status: "not-directory", kind: "device" };
      if (source === "/etc/hosts") return { status: "not-directory", kind: "file" };
      return { status: "available" };
    });

    const plan = await planBackup(plannerInput(services), deps);

    expect(plan.mounts).toEqual([]);
    expect(plan.skipped.map((item) => item.reasonCode)).toEqual([
      "DEVICE_SOURCE",
      "READ_ONLY_SYSTEM_FILE",
      "HOST_SYSTEM_PATH",
      "SOCKET_SOURCE",
      "NON_PERSISTENT_TMPFS",
    ]);
  });

  it("archives a directory whose name ends in .sock when the authority probe confirms it", async () => {
    const services = {
      app: service("app", [
        { type: "bind", source: "/srv/data.sock", target: "/data", read_only: false },
      ]),
    };
    const deps = dependencies(() => ({ status: "available" }));

    const plan = await planBackup(plannerInput(services), deps);

    expect(deps.probeSource).toHaveBeenCalledWith({ kind: "bind", path: "/srv/data.sock" });
    expect(plan.skipped).toEqual([]);
    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]?.source).toEqual({ kind: "bind", path: "/srv/data.sock" });
  });

  it.each([
    {
      name: "anonymous volume",
      mount: { type: "volume", target: "/data", read_only: false },
      probe: (): BackupSourceProbeResult => ({ status: "available" }),
      code: "ANONYMOUS_VOLUME",
    },
    {
      name: "short syntax",
      mount: "/srv/data:/data",
      probe: (): BackupSourceProbeResult => ({ status: "available" }),
      code: "UNSUPPORTED_MOUNT_TYPE",
    },
    {
      name: "missing bind",
      mount: { type: "bind", source: "/srv/data", target: "/data", read_only: false },
      probe: (): BackupSourceProbeResult => ({ status: "missing" }),
      code: "BIND_SOURCE_MISSING",
    },
    {
      name: "writable file",
      mount: { type: "bind", source: "/srv/file", target: "/data", read_only: false },
      probe: (): BackupSourceProbeResult => ({ status: "not-directory", kind: "file" }),
      code: "BIND_SOURCE_NOT_DIRECTORY",
    },
    {
      name: "missing named volume",
      mount: { type: "volume", source: "data", target: "/data", read_only: false },
      probe: (): BackupSourceProbeResult => ({ status: "missing" }),
      code: "NAMED_VOLUME_MISSING",
    },
  ] as const)("fails closed for $name", async ({ mount, probe, code }) => {
    const input = plannerInput({ app: service("app", [mount]) });
    await expectPlannerError(input, dependencies(probe), code);
  });

  it("rejects unsupported canonical mount types retained by evidence", async () => {
    const app = {
      ...service("app", []),
      unsupported_volumes: [
        { type: "cluster", source: "remote", target: "/data", read_only: false },
      ],
    };

    await expectPlannerError(plannerInput({ app }), dependencies(), "UNSUPPORTED_MOUNT_TYPE");
  });

  it("fails closed on probe errors", async () => {
    const deps: BackupPlannerDependencies = {
      probeSource: async () => {
        throw new Error("secret endpoint");
      },
      probeBindTopology: async (sourcePaths) => ({
        entries: sourcePaths.map((sourcePath) => ({
          sourcePath,
          majorMinor: "8:1",
          mountRoot: sourcePath,
        })),
        fingerprint: "c".repeat(64),
      }),
    };
    await expectPlannerError(
      plannerInput({
        app: service("app", [
          { type: "bind", source: "/srv/data", target: "/data", read_only: false },
        ]),
      }),
      deps,
      "SOURCE_PROBE_FAILED",
    );
  });

  it("rejects nested selected bind sources", async () => {
    await expectPlannerError(
      plannerInput({
        app: service("app", [
          { type: "bind", source: "/srv/data", target: "/data", read_only: false },
          { type: "bind", source: "/srv/data/cache", target: "/cache", read_only: false },
        ]),
      }),
      dependencies(),
      "NESTED_SELECTED_BIND",
    );
  });

  it("rejects distinct selected paths with the same daemon identity", async () => {
    await expectPlannerError(
      plannerInput({
        app: service("app", [
          { type: "bind", source: "/srv/data", target: "/data", read_only: false },
          { type: "bind", source: "/alias/data", target: "/alias", read_only: false },
        ]),
      }),
      dependencies(undefined, (sourcePaths) => ({
        entries: sourcePaths.map((sourcePath) => ({
          sourcePath,
          majorMinor: "8:1",
          mountRoot: "/srv/data",
        })),
        fingerprint: "d".repeat(64),
      })),
      "AMBIGUOUS_BIND_PATH",
    );
  });

  it("rejects daemon-identity nesting across lexically unrelated selected paths", async () => {
    await expectPlannerError(
      plannerInput({
        app: service("app", [
          { type: "bind", source: "/selected/one", target: "/one", read_only: false },
          { type: "bind", source: "/selected/two", target: "/two", read_only: false },
        ]),
      }),
      dependencies(undefined, (sourcePaths) => ({
        entries: sourcePaths.map((sourcePath) => ({
          sourcePath,
          majorMinor: "8:1",
          mountRoot: sourcePath.endsWith("/one") ? "/srv/data" : "/srv/data/cache",
        })),
        fingerprint: "d".repeat(64),
      })),
      "NESTED_SELECTED_BIND",
    );
  });

  it("quiesces aliased writers but not unrelated roots on the same device", async () => {
    const services = {
      app: service("app", [
        { type: "bind", source: "/selected/data", target: "/data", read_only: true },
      ]),
      aliasWriter: service("aliasWriter", [
        { type: "bind", source: "/writer/alias", target: "/write", read_only: false },
      ]),
      unrelatedWriter: service("unrelatedWriter", [
        { type: "bind", source: "/writer/unrelated", target: "/write", read_only: false },
      ]),
    };
    const plan = await planBackup(
      plannerInput(services),
      dependencies(undefined, (sourcePaths) => ({
        entries: sourcePaths.map((sourcePath) => ({
          sourcePath,
          majorMinor: "8:1",
          mountRoot:
            sourcePath === "/writer/unrelated"
              ? "/srv/unrelated"
              : sourcePath === "/backup"
                ? "/backup"
                : "/srv/canonical-data",
        })),
        fingerprint: "d".repeat(64),
      })),
    );

    expect(plan.mounts[0]?.writerServices).toEqual(["aliasWriter"]);
    expect(plan.mounts[0]?.consumers).toEqual([
      { service: "aliasWriter", target: "/write", readOnly: false },
      { service: "app", target: "/data", readOnly: true },
    ]);
    expect(plan.bindTopologyFingerprint).toBe("d".repeat(64));
  });

  it("fails closed when daemon topology evidence is missing", async () => {
    await expectPlannerError(
      plannerInput({
        app: service("app", [
          { type: "bind", source: "/srv/data", target: "/data", read_only: false },
        ]),
      }),
      dependencies(undefined, () => ({
        entries: [],
        fingerprint: "d".repeat(64),
      })),
      "AMBIGUOUS_BIND_PATH",
    );
  });

  it("rejects lexically ambiguous bind paths", async () => {
    await expectPlannerError(
      plannerInput({
        app: service("app", [
          { type: "bind", source: "/srv/../data", target: "/data", read_only: false },
        ]),
      }),
      dependencies(),
      "AMBIGUOUS_BIND_PATH",
    );
  });

  it("checks destination containment only for a local Docker authority", async () => {
    const services = {
      app: service("app", [
        { type: "bind", source: "/srv/data", target: "/data", read_only: false },
      ]),
    };
    await expectPlannerError(
      plannerInput(services, { canonicalDestination: "/srv/data/backups" }),
      dependencies(),
      "DESTINATION_INSIDE_SOURCE",
    );

    await expect(
      planBackup(
        plannerInput(services, {
          canonicalDestination: "/srv/data/backups",
          localDockerAuthority: false,
        }),
        dependencies(),
      ),
    ).resolves.toMatchObject({ canonicalDestination: "/srv/data/backups" });
  });

  it.each([
    { name: "aliased descendant", destinationRoot: "/srv/data/backups" },
    { name: "equal alias", destinationRoot: "/srv/data" },
    { name: "aliased ancestor", destinationRoot: "/srv" },
  ])(
    "rejects a local destination with $name daemon identity overlap",
    async ({ destinationRoot }) => {
      const destinationPath = "/backup/destination";
      await expectPlannerError(
        plannerInput(
          {
            app: service("app", [
              { type: "bind", source: "/alias/data", target: "/data", read_only: false },
            ]),
          },
          { canonicalDestination: destinationPath },
        ),
        dependencies(undefined, (sourcePaths) => ({
          entries: sourcePaths.map((sourcePath) => ({
            sourcePath,
            majorMinor: "8:1",
            mountRoot: sourcePath === destinationPath ? destinationRoot : "/srv/data",
          })),
          fingerprint: "d".repeat(64),
        })),
        "DESTINATION_INSIDE_SOURCE",
      );
    },
  );

  it("fails closed when local destination identity evidence is missing", async () => {
    const destinationPath = "/backup";
    await expectPlannerError(
      plannerInput({
        app: service("app", [
          { type: "bind", source: "/srv/data", target: "/data", read_only: false },
        ]),
      }),
      dependencies(undefined, (sourcePaths) => ({
        entries: sourcePaths
          .filter((sourcePath) => sourcePath !== destinationPath)
          .map((sourcePath) => ({
            sourcePath,
            majorMinor: "8:1",
            mountRoot: sourcePath,
          })),
        fingerprint: "d".repeat(64),
      })),
      "AMBIGUOUS_BIND_PATH",
    );
  });

  it("does not mix a remote destination into daemon bind topology evidence", async () => {
    const services = {
      app: service("app", [
        { type: "bind", source: "/srv/data", target: "/data", read_only: false },
      ]),
    };
    const deps = dependencies();

    await planBackup(
      plannerInput(services, {
        canonicalDestination: "/srv/data/backups",
        localDockerAuthority: false,
      }),
      deps,
    );

    expect(deps.probeBindTopology).toHaveBeenCalledWith(["/srv/data"]);
  });

  it("rejects dependency cycles before any source probe", async () => {
    const deps = dependencies();
    await expectPlannerError(
      plannerInput({
        app: service("app", [], ["database"]),
        database: service("database", [], ["app"]),
      }),
      deps,
      "DEPENDENCY_CYCLE",
    );
    expect(deps.probeSource).not.toHaveBeenCalled();
  });
});
