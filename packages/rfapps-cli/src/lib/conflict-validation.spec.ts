import { describe, expect, it } from "vitest";
import { evaluateConflictValidation, formatConflictValidationText } from "./conflict-validation.js";
import type {
  ConflictMountProjection,
  ConflictValidationInput,
  DesiredNetworkProjection,
  DesiredPortAllocation,
  DesiredPortClaim,
  DesiredServiceProjection,
  DesiredVolumeProjection,
  PortAddressFamily,
  PortProtocol,
  RuntimeContainerProjection,
  RuntimeNetworkProjection,
  RuntimePortClaim,
  RuntimeVolumeProjection,
} from "../types/validation.js";

const UNSAFE_DISPLAY_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function desiredPort(
  allocation: DesiredPortAllocation,
  options: {
    readonly service?: string;
    readonly family?: PortAddressFamily;
    readonly hostIp?: string;
    readonly protocol?: PortProtocol;
  } = {},
): DesiredPortClaim {
  return {
    kind: "port",
    origin: "desired",
    project: "media",
    service: options.service ?? "web",
    family: options.family ?? "ipv4",
    hostIp: options.hostIp ?? "0.0.0.0",
    protocol: options.protocol ?? "tcp",
    allocation,
  };
}

function fixedPort(
  start: number,
  options: {
    readonly end?: number;
    readonly service?: string;
    readonly family?: PortAddressFamily;
    readonly hostIp?: string;
    readonly protocol?: PortProtocol;
  } = {},
): DesiredPortClaim {
  return desiredPort({ mode: "fixed", published: { start, end: options.end ?? start } }, options);
}

function runtimePort(
  start: number,
  options: {
    readonly end?: number;
    readonly family?: PortAddressFamily;
    readonly hostIp?: string;
    readonly protocol?: PortProtocol;
    readonly containerId?: string;
    readonly containerName?: string;
    readonly project?: string;
    readonly service?: string;
  } = {},
): RuntimePortClaim {
  return {
    kind: "port",
    origin: "runtime",
    containerId: options.containerId ?? "runtime-id",
    containerName: options.containerName ?? "runtime",
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.service === undefined ? {} : { service: options.service }),
    family: options.family ?? "ipv4",
    hostIp: options.hostIp ?? "0.0.0.0",
    protocol: options.protocol ?? "tcp",
    published: { start, end: options.end ?? start },
  };
}

function service(
  name: string,
  options: {
    readonly ports?: readonly DesiredPortClaim[];
    readonly mounts?: readonly ConflictMountProjection[];
    readonly networks?: readonly string[];
  } = {},
): DesiredServiceProjection {
  return {
    project: "media",
    service: name,
    ports: options.ports ?? [],
    mounts: options.mounts ?? [],
    networks: options.networks ?? [],
    dependencies: [],
  };
}

function container(
  options: {
    readonly id?: string;
    readonly name?: string;
    readonly project?: string;
    readonly service?: string;
    readonly ports?: readonly RuntimePortClaim[];
    readonly mounts?: readonly ConflictMountProjection[];
  } = {},
): RuntimeContainerProjection {
  return {
    id: options.id ?? "runtime-id",
    name: options.name ?? "runtime",
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.service === undefined ? {} : { service: options.service }),
    ports: options.ports ?? [],
    mounts: options.mounts ?? [],
  };
}

function volume(
  key: string,
  name: string,
  options: {
    readonly external?: boolean;
    readonly driver?: string;
    readonly driverOptions?: Readonly<Record<string, string>>;
  } = {},
): DesiredVolumeProjection {
  return {
    key,
    name,
    external: options.external ?? false,
    driver: options.driver ?? "local",
    driverOptions: options.driverOptions ?? {},
  };
}

function runtimeVolume(
  name: string,
  options: {
    readonly driver?: string;
    readonly driverOptions?: Readonly<Record<string, string>>;
  } = {},
): RuntimeVolumeProjection {
  return {
    name,
    driver: options.driver ?? "local",
    driverOptions: options.driverOptions ?? {},
  };
}

function network(
  key: string,
  name: string,
  subnets: readonly string[],
  driver = "bridge",
): DesiredNetworkProjection {
  return { key, name, external: false, driver, subnets };
}

function runtimeNetwork(
  id: string,
  name: string,
  subnets: readonly string[],
  driver = "bridge",
): RuntimeNetworkProjection {
  return { id, name, driver, subnets };
}

function validationInput(
  options: {
    readonly services?: readonly DesiredServiceProjection[];
    readonly containers?: readonly RuntimeContainerProjection[];
    readonly volumes?: readonly DesiredVolumeProjection[];
    readonly runtimeVolumes?: readonly RuntimeVolumeProjection[];
    readonly networks?: readonly DesiredNetworkProjection[];
    readonly runtimeNetworks?: readonly RuntimeNetworkProjection[];
    readonly volumeEvidenceAvailable?: boolean;
    readonly scopeServices?: readonly string[];
    readonly project?: string;
  } = {},
): ConflictValidationInput {
  const services = options.services ?? [service("web")];
  return {
    scope: {
      project: options.project ?? "media",
      services: options.scopeServices ?? services.map((entry) => entry.service),
      profiles: ["all"],
    },
    desired: {
      project: options.project ?? "media",
      services,
      volumes: options.volumes ?? [],
      networks: options.networks ?? [],
    },
    runtime: {
      containers: options.containers ?? [],
      volumes: options.runtimeVolumes ?? [],
      networks: options.runtimeNetworks ?? [],
      ...(options.volumeEvidenceAvailable === undefined
        ? {}
        : { volumeEvidenceAvailable: options.volumeEvidenceAvailable }),
      authorityFingerprint: "authority-fingerprint",
      composeFingerprint: "compose-fingerprint",
    },
  };
}

function portCodes(input: ConflictValidationInput): string[] {
  return evaluateConflictValidation(input).conflicts.map((finding) => finding.code);
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
    deepFreeze(child);
  }
  Object.freeze(value);
}

describe("evaluateConflictValidation ports", () => {
  it.each([
    {
      name: "blocks an IPv4 wildcard against a specific IPv4 bind",
      desired: fixedPort(8080),
      observed: runtimePort(8080, { hostIp: "127.0.0.1" }),
      blocked: true,
    },
    {
      name: "allows distinct specific IPv4 addresses",
      desired: fixedPort(8080, { hostIp: "127.0.0.1" }),
      observed: runtimePort(8080, { hostIp: "127.0.0.2" }),
      blocked: false,
    },
    {
      name: "keeps TCP and UDP independent",
      desired: fixedPort(8080, { protocol: "tcp" }),
      observed: runtimePort(8080, { protocol: "udp" }),
      blocked: false,
    },
    {
      name: "keeps IPv4 and IPv6 independent",
      desired: fixedPort(8080, { family: "ipv4", hostIp: "0.0.0.0" }),
      observed: runtimePort(8080, { family: "ipv6", hostIp: "::" }),
      blocked: false,
    },
    {
      name: "blocks intersecting fixed intervals",
      desired: fixedPort(8_000, { end: 8_010 }),
      observed: runtimePort(8_010, { end: 8_020 }),
      blocked: true,
    },
    {
      name: "allows adjacent fixed intervals",
      desired: fixedPort(8_000, { end: 8_010 }),
      observed: runtimePort(8_011, { end: 8_020 }),
      blocked: false,
    },
  ])("$name", ({ desired, observed, blocked }) => {
    const input = validationInput({
      services: [service("web", { ports: [desired] })],
      containers: [container({ ports: [observed] })],
    });

    expect(portCodes(input)).toEqual(blocked ? ["PORT_BINDING_CONFLICT"] : []);
  });

  it("detects conflicts between two desired fixed claims", () => {
    const input = validationInput({
      services: [
        service("api", { ports: [fixedPort(8080, { service: "api" })] }),
        service("web", { ports: [fixedPort(8080, { service: "web" })] }),
      ],
    });

    const result = evaluateConflictValidation(input);

    expect(result.status).toBe("blocked");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.origin).toBe("desired");
    expect(result.conflicts[0]?.parties.map((party) => party.name)).toEqual(["api", "web"]);
  });

  it.each([
    {
      name: "passes when part of a choice range remains free",
      blockers: [runtimePort(8_000, { end: 8_001 })],
      blocked: false,
    },
    {
      name: "blocks only when a choice range is exhausted",
      blockers: [runtimePort(8_000, { end: 8_002 })],
      blocked: true,
    },
  ])("$name", ({ blockers, blocked }) => {
    const choice = desiredPort({
      mode: "choice",
      published: { start: 8_000, end: 8_002 },
    });
    const input = validationInput({
      services: [service("web", { ports: [choice] })],
      containers: [container({ ports: blockers })],
    });

    expect(portCodes(input)).toEqual(blocked ? ["PORT_RANGE_EXHAUSTED"] : []);
  });

  it("finds a globally feasible mixed wildcard and specific choice assignment", () => {
    const input = validationInput({
      services: [
        service("specific-a", {
          ports: [
            desiredPort(
              { mode: "choice", published: { start: 8_000, end: 8_001 } },
              { service: "specific-a", hostIp: "127.0.0.1" },
            ),
          ],
        }),
        service("wildcard", {
          ports: [
            desiredPort(
              { mode: "choice", published: { start: 8_000, end: 8_001 } },
              { service: "wildcard" },
            ),
          ],
        }),
        service("specific-b", {
          ports: [
            desiredPort(
              { mode: "choice", published: { start: 8_001, end: 8_001 } },
              { service: "specific-b", hostIp: "127.0.0.2" },
            ),
          ],
        }),
      ],
    });

    expect(evaluateConflictValidation(input).status).toBe("passed");
  });

  it("bounds a ten-port wildcard search while proving exhaustion", () => {
    const interval = { start: 8_000, end: 8_009 };
    const input = validationInput({
      services: [
        ...Array.from({ length: 10 }, (_, index) =>
          service(`wildcard-${index}`, {
            ports: [
              desiredPort(
                { mode: "choice", published: interval },
                { service: `wildcard-${index}` },
              ),
            ],
          }),
        ),
        service("specific", {
          ports: [
            desiredPort(
              { mode: "choice", published: interval },
              { service: "specific", hostIp: "127.0.0.1" },
            ),
          ],
        }),
      ],
    });

    expect(portCodes(input)).toEqual(["PORT_RANGE_EXHAUSTED"]);
  }, 1_000);

  it("reports an over-budget choice search as inconclusive without a false block", () => {
    const interval = { start: 8_000, end: 8_011 };
    const input = validationInput({
      services: [
        ...Array.from({ length: 12 }, (_, index) =>
          service(`wildcard-${index}`, {
            ports: [
              desiredPort(
                { mode: "choice", published: interval },
                { service: `wildcard-${index}` },
              ),
            ],
          }),
        ),
        service("specific", {
          ports: [
            desiredPort(
              { mode: "choice", published: interval },
              { service: "specific", hostIp: "127.0.0.1" },
            ),
          ],
        }),
      ],
    });

    const result = evaluateConflictValidation(input);

    expect(result.status).toBe("inconclusive");
    expect(result.conflicts).toEqual([]);
    expect(result.status === "inconclusive" ? result.error.code : undefined).toBe(
      "EVIDENCE_LIMIT_EXCEEDED",
    );
  }, 1_000);

  it.each([
    {
      name: "blocks two choice claims competing for one compatible port",
      interval: { start: 8_000, end: 8_000 },
      blocked: true,
    },
    {
      name: "allocates distinct candidates when a choice pool has capacity",
      interval: { start: 8_000, end: 8_001 },
      blocked: false,
    },
  ])("$name", ({ interval, blocked }) => {
    const input = validationInput({
      services: [
        service("api", {
          ports: [desiredPort({ mode: "choice", published: interval }, { service: "api" })],
        }),
        service("web", {
          ports: [desiredPort({ mode: "choice", published: interval }, { service: "web" })],
        }),
      ],
    });

    expect(portCodes(input)).toEqual(blocked ? ["PORT_RANGE_EXHAUSTED"] : []);
  });

  it("does not turn dynamic allocation into a fixed claim", () => {
    const input = validationInput({
      services: [service("web", { ports: [desiredPort({ mode: "dynamic" })] })],
      containers: [container({ ports: [runtimePort(8080)] })],
    });

    const result = evaluateConflictValidation(input);

    expect(result.status).toBe("passed");
    expect(result.limitations.map((entry) => entry.code)).toContain(
      "DYNAMIC_PORT_ALLOCATION_NOT_PREDICTED",
    );
  });

  it.each([
    {
      name: "excludes a selected service container with authoritative labels",
      project: "media",
      serviceName: "web",
      blocked: false,
    },
    {
      name: "does not exclude a similarly named container from another project",
      project: "other",
      serviceName: "web",
      blocked: true,
    },
    {
      name: "does not exclude a container without service ownership",
      project: "media",
      serviceName: undefined,
      blocked: true,
    },
  ])("$name", ({ project, serviceName, blocked }) => {
    const input = validationInput({
      services: [service("web", { ports: [fixedPort(8080)] })],
      containers: [
        container({
          project,
          ...(serviceName === undefined ? {} : { service: serviceName }),
          ports: [runtimePort(8080)],
        }),
      ],
    });

    expect(portCodes(input)).toEqual(blocked ? ["PORT_BINDING_CONFLICT"] : []);
  });
});

describe("evaluateConflictValidation volumes", () => {
  it("allows ordinary shared mounts and mixed access modes", () => {
    const input = validationInput({
      services: [
        service("one", {
          mounts: [{ type: "bind", source: "/srv/media", target: "/media", readOnly: false }],
        }),
        service("two", {
          mounts: [{ type: "bind", source: "/srv/media", target: "/library", readOnly: true }],
        }),
      ],
    });

    expect(evaluateConflictValidation(input).status).toBe("passed");
  });

  it.each([
    {
      name: "driver mismatch",
      left: volume("one", "shared", { driver: "local" }),
      right: volume("two", "shared", { driver: "custom" }),
    },
    {
      name: "driver option mismatch",
      left: volume("one", "shared", { driverOptions: { type: "nfs", device: ":/one" } }),
      right: volume("two", "shared", { driverOptions: { device: ":/two", type: "nfs" } }),
    },
  ])("blocks desired definitions with a $name", ({ left, right }) => {
    const input = validationInput({
      services: [
        service("one", {
          mounts: [{ type: "volume", source: "one", target: "/one", readOnly: false }],
        }),
        service("two", {
          mounts: [{ type: "volume", source: "two", target: "/two", readOnly: false }],
        }),
      ],
      volumes: [left, right],
    });

    expect(evaluateConflictValidation(input).conflicts.map((entry) => entry.code)).toContain(
      "VOLUME_DEFINITION_CONFLICT",
    );
  });

  it("normalizes driver option ordering before comparison", () => {
    const input = validationInput({
      services: [
        service("one", {
          mounts: [{ type: "volume", source: "one", target: "/one", readOnly: false }],
        }),
        service("two", {
          mounts: [{ type: "volume", source: "two", target: "/two", readOnly: true }],
        }),
      ],
      volumes: [
        volume("one", "shared", { driverOptions: { type: "nfs", device: ":/media" } }),
        volume("two", "shared", { driverOptions: { device: ":/media", type: "nfs" } }),
      ],
    });

    expect(evaluateConflictValidation(input).status).toBe("passed");
  });

  it.each([
    {
      name: "two external references",
      volumes: [
        volume("one", "shared", { external: true, driver: "one-driver" }),
        volume("two", "shared", { external: true, driver: "two-driver" }),
      ],
    },
    {
      name: "an external reference and a Compose-owned definition",
      volumes: [
        volume("one", "shared", { external: true, driver: "ignored-driver" }),
        volume("two", "shared", { driver: "local" }),
      ],
    },
  ])("does not apply driver policy between $name", ({ volumes }) => {
    const input = validationInput({
      services: [
        service("one", {
          mounts: [{ type: "volume", source: "one", target: "/one", readOnly: false }],
        }),
        service("two", {
          mounts: [{ type: "volume", source: "two", target: "/two", readOnly: false }],
        }),
      ],
      volumes,
      runtimeVolumes: [runtimeVolume("shared", { driver: "local" })],
    });

    expect(evaluateConflictValidation(input).conflicts.map((entry) => entry.code)).not.toContain(
      "VOLUME_DEFINITION_CONFLICT",
    );
    expect(evaluateConflictValidation(input).status).toBe("passed");
  });

  it("blocks a non-external desired definition that disagrees with runtime", () => {
    const input = validationInput({
      services: [
        service("web", {
          mounts: [{ type: "volume", source: "data", target: "/data", readOnly: false }],
        }),
      ],
      volumes: [volume("data", "media_data", { driver: "local" })],
      runtimeVolumes: [runtimeVolume("media_data", { driver: "custom" })],
    });

    expect(evaluateConflictValidation(input).conflicts.map((entry) => entry.code)).toEqual([
      "VOLUME_RUNTIME_CONFLICT",
    ]);
  });

  it.each([
    {
      name: "blocks a missing required external volume",
      runtimeVolumes: [] as readonly RuntimeVolumeProjection[],
      blocked: true,
    },
    {
      name: "does not impose driver policy on an existing external volume",
      runtimeVolumes: [runtimeVolume("shared_data", { driver: "custom" })],
      blocked: false,
    },
  ])("$name", ({ runtimeVolumes, blocked }) => {
    const input = validationInput({
      services: [
        service("web", {
          mounts: [{ type: "volume", source: "data", target: "/data", readOnly: false }],
        }),
      ],
      volumes: [volume("data", "shared_data", { external: true })],
      runtimeVolumes,
    });

    expect(evaluateConflictValidation(input).conflicts.map((entry) => entry.code)).toEqual(
      blocked ? ["EXTERNAL_VOLUME_MISSING"] : [],
    );
  });

  it.each([
    {
      name: "blocks different source identities at one service target",
      mounts: [
        { type: "bind", source: "/srv/one", target: "/data", readOnly: false },
        { type: "bind", source: "/srv/two", target: "/data", readOnly: true },
      ] satisfies readonly ConflictMountProjection[],
      blocked: true,
    },
    {
      name: "blocks different mount types at one service target",
      mounts: [
        { type: "bind", source: "/srv/one", target: "/data", readOnly: false },
        { type: "volume", source: "data", target: "/data", readOnly: false },
      ] satisfies readonly ConflictMountProjection[],
      blocked: true,
    },
    {
      name: "allows access-mode differences for the same mount identity",
      mounts: [
        { type: "bind", source: "/srv/one", target: "/data", readOnly: false },
        { type: "bind", source: "/srv/one", target: "/data", readOnly: true },
      ] satisfies readonly ConflictMountProjection[],
      blocked: false,
    },
  ])("$name", ({ mounts, blocked }) => {
    const result = evaluateConflictValidation(
      validationInput({ services: [service("web", { mounts })] }),
    );

    expect(result.conflicts.map((entry) => entry.code)).toEqual(
      blocked ? ["VOLUME_TARGET_CONFLICT"] : [],
    );
  });
});

describe("evaluateConflictValidation networks", () => {
  it.each([
    {
      name: "blocks overlapping IPv4 subnets",
      desiredSubnet: "10.0.0.0/24",
      runtimeSubnet: "10.0.0.128/25",
      blocked: true,
    },
    {
      name: "allows adjacent IPv4 subnets",
      desiredSubnet: "10.0.0.0/25",
      runtimeSubnet: "10.0.0.128/25",
      blocked: false,
    },
    {
      name: "blocks IPv6 containment",
      desiredSubnet: "2001:db8::/48",
      runtimeSubnet: "2001:db8:0:1::/64",
      blocked: true,
    },
    {
      name: "keeps IPv4 and IPv6 separate",
      desiredSubnet: "10.0.0.0/24",
      runtimeSubnet: "2001:db8::/64",
      blocked: false,
    },
  ])("$name", ({ desiredSubnet, runtimeSubnet, blocked }) => {
    const input = validationInput({
      services: [service("web", { networks: ["app"] })],
      networks: [network("app", "media_app", [desiredSubnet])],
      runtimeNetworks: [runtimeNetwork("other-id", "other", [runtimeSubnet])],
    });

    expect(evaluateConflictValidation(input).conflicts.map((entry) => entry.code)).toEqual(
      blocked ? ["NETWORK_SUBNET_CONFLICT"] : [],
    );
  });

  it("detects overlap between two desired networks", () => {
    const input = validationInput({
      services: [service("web", { networks: ["one", "two"] })],
      networks: [
        network("one", "media_one", ["172.20.0.0/24"]),
        network("two", "media_two", ["172.20.0.0/25"]),
      ],
    });

    const result = evaluateConflictValidation(input);

    expect(result.status).toBe("blocked");
    expect(result.conflicts[0]?.origin).toBe("desired");
  });

  it("excludes the exact existing network identity Compose intends to reuse", () => {
    const input = validationInput({
      services: [service("web", { networks: ["app"] })],
      networks: [network("app", "media_app", ["172.20.0.0/24"])],
      runtimeNetworks: [runtimeNetwork("same-id", "media_app", ["172.20.0.0/24"])],
    });

    expect(evaluateConflictValidation(input).status).toBe("passed");
  });

  it("excludes an intended runtime network before parsing its subnet evidence", () => {
    const input = validationInput({
      services: [service("web", { networks: ["app"] })],
      networks: [network("app", "media_app", ["172.20.0.0/24"])],
      runtimeNetworks: [runtimeNetwork("same-id", "media_app", ["malformed-cidr"])],
    });

    const result = evaluateConflictValidation(input);

    expect(result.status).toBe("passed");
    expect(result.checks.find((check) => check.id === "normalization")?.status).toBe("passed");
  });

  it("reports auto-assigned desired networks as a limitation", () => {
    const input = validationInput({
      services: [service("web", { networks: ["app"] })],
      networks: [network("app", "media_app", [])],
    });

    const result = evaluateConflictValidation(input);

    expect(result.status).toBe("passed");
    expect(result.limitations.map((entry) => entry.code)).toContain(
      "AUTO_ASSIGNED_NETWORK_SUBNETS_NOT_CHECKED",
    );
  });
});

describe("evaluateConflictValidation result invariants", () => {
  it("does not spend runtime-volume budget when that evidence lane is unavailable", () => {
    const volumes = Array.from({ length: 497 }, (_, index) =>
      volume(`data-${index}`, `shared-${index}`, { external: true }),
    );
    const mounts = volumes.map((entry, index) => ({
      type: "volume" as const,
      source: entry.key,
      target: `/data/${index}`,
      readOnly: false,
    }));
    const result = evaluateConflictValidation(
      validationInput({
        services: [service("web", { mounts, networks: ["app"] })],
        volumes,
        networks: [network("app", "media_app", ["10.0.0.0/24"])],
        runtimeNetworks: [runtimeNetwork("other-id", "other", ["10.0.0.128/25"])],
        volumeEvidenceAvailable: false,
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.conflicts).toEqual([
      expect.objectContaining({ code: "NETWORK_SUBNET_CONFLICT", kind: "network" }),
    ]);
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "normalization", status: "passed" })]),
    );
  });

  it("accepts the aggregate projected-claim boundary and fails closed one claim beyond it", () => {
    const containers = Array.from({ length: 4_094 }, (_, index) =>
      container({ id: `runtime-${index}`, name: `runtime-${index}` }),
    );
    const atLimit = validationInput({ containers: containers.slice(0, 4_093) });
    const overLimit = validationInput({ containers });

    expect(evaluateConflictValidation(atLimit).status).toBe("passed");
    const first = evaluateConflictValidation(overLimit);
    const second = evaluateConflictValidation({
      ...overLimit,
      runtime: {
        ...overLimit.runtime,
        containers: [...overLimit.runtime.containers].reverse(),
      },
    });
    expect(first).toEqual(second);
    expect(first.status).toBe("inconclusive");
    expect(first.status === "inconclusive" ? first.error : undefined).toEqual({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "normalization",
      message: "Projected resource claims exceeded the deterministic validation limit.",
    });
  });

  it("accepts the aggregate comparison-work boundary and fails closed one comparison beyond it", () => {
    const services = Array.from({ length: 1_000 }, (_, index) =>
      service(`service-${index.toString().padStart(3, "0")}`, {
        ports: [
          fixedPort(10_000 + index, {
            service: `service-${index.toString().padStart(3, "0")}`,
          }),
        ],
      }),
    );

    expect(evaluateConflictValidation(validationInput({ services })).status).toBe("passed");
    const result = evaluateConflictValidation(
      validationInput({
        services,
        containers: [container({ ports: [runtimePort(60_000)] })],
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.status === "inconclusive" ? result.error : undefined).toEqual({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "normalization",
      message: "Resource comparison work exceeded the deterministic validation limit.",
    });
    expect(result.conflicts).toEqual([]);
  });

  it("caps aggregate findings and fails closed when one additional finding would be emitted", () => {
    const services = Array.from({ length: 33 }, (_, index) =>
      service(`service-${index.toString().padStart(2, "0")}`, {
        ports: [
          fixedPort(8_080, {
            service: `service-${index.toString().padStart(2, "0")}`,
          }),
        ],
      }),
    );

    const atLimit = evaluateConflictValidation(
      validationInput({ services: services.slice(0, 32) }),
    );
    expect(atLimit.status).toBe("blocked");
    expect(atLimit.conflicts).toHaveLength(496);

    const overLimit = evaluateConflictValidation(validationInput({ services }));
    expect(overLimit.status).toBe("inconclusive");
    expect(overLimit.status === "inconclusive" ? overLimit.error : undefined).toEqual({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "normalization",
      message: "Conflict findings exceeded the deterministic validation limit.",
    });
    expect(overLimit.conflicts).toHaveLength(496);
  });

  it("makes malformed CIDR evidence inconclusive while retaining definite conflicts", () => {
    const input = validationInput({
      services: [
        service("web", {
          ports: [fixedPort(8080)],
          networks: ["app"],
        }),
      ],
      containers: [container({ ports: [runtimePort(8080)] })],
      networks: [network("app", "media_app", ["not-a-cidr"])],
    });

    const result = evaluateConflictValidation(input);

    expect(result.status).toBe("inconclusive");
    if (result.status !== "inconclusive") {
      throw new Error("Expected an inconclusive result");
    }
    expect(result.error).toEqual({
      code: "INVALID_CIDR",
      check: "normalization",
      message: "An explicit subnet for desired network media_app is invalid.",
    });
    expect(result.conflicts.map((entry) => entry.code)).toEqual(["PORT_BINDING_CONFLICT"]);
    expect(result.checks.find((check) => check.id === "normalization")?.status).toBe("failed");
  });

  it("is deterministic across permutations of every evidence collection", () => {
    const first = validationInput({
      services: [
        service("zeta", {
          ports: [fixedPort(8080, { service: "zeta" })],
          networks: ["zeta"],
        }),
        service("alpha", {
          ports: [fixedPort(8080, { service: "alpha" })],
          networks: ["alpha"],
        }),
      ],
      containers: [
        container({
          id: "z-id",
          name: "z-runtime",
          ports: [runtimePort(8080, { containerId: "z-id", containerName: "z-runtime" })],
        }),
        container({
          id: "a-id",
          name: "a-runtime",
          ports: [runtimePort(8080, { containerId: "a-id", containerName: "a-runtime" })],
        }),
      ],
      networks: [
        network("zeta", "media_zeta", ["172.20.0.0/24"]),
        network("alpha", "media_alpha", ["172.20.0.0/25"]),
      ],
      runtimeNetworks: [
        runtimeNetwork("z-network", "z-runtime", ["172.20.0.0/26"]),
        runtimeNetwork("a-network", "a-runtime", ["172.20.0.64/26"]),
      ],
      scopeServices: ["zeta", "alpha"],
    });
    const second = validationInput({
      services: [...first.desired.services].reverse(),
      containers: [...first.runtime.containers].reverse(),
      volumes: [...first.desired.volumes].reverse(),
      runtimeVolumes: [...first.runtime.volumes].reverse(),
      networks: [...first.desired.networks].reverse(),
      runtimeNetworks: [...first.runtime.networks].reverse(),
      scopeServices: [...first.scope.services].reverse(),
    });

    expect(evaluateConflictValidation(second)).toEqual(evaluateConflictValidation(first));
  });

  it("sanitizes public strings, bidi controls, and IDs without exposing bind sources", () => {
    const secretSource = "/host/private/credential-path";
    const hostileService = "web\n\u001b[31m\u061c\u200eevil\u202e\u2066";
    const hostileOwner = "owner\n\u001b[31m\u200f\u202eevil\u2066";
    const input = validationInput({
      services: [
        service(hostileService, {
          ports: [fixedPort(8080, { service: hostileService })],
          mounts: [
            { type: "bind", source: secretSource, target: "/data", readOnly: false },
            { type: "bind", source: "/other/private/path", target: "/data", readOnly: false },
          ],
        }),
      ],
      containers: [
        container({
          name: hostileOwner,
          ports: [
            runtimePort(8080, {
              containerName: hostileOwner,
            }),
          ],
        }),
      ],
      scopeServices: [hostileService],
    });

    const result = evaluateConflictValidation(input);
    const serialized = JSON.stringify(result);
    const lines = formatConflictValidationText(result);

    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts.every((entry) => /^[a-z0-9-]+$/u.test(entry.id))).toBe(true);
    expect(serialized).not.toContain(secretSource);
    expect(serialized).not.toMatch(UNSAFE_DISPLAY_CHARACTERS);
    expect(lines.every((line) => !UNSAFE_DISPLAY_CHARACTERS.test(line))).toBe(true);
  });

  it("does not mutate deeply frozen input projections", () => {
    const input = validationInput({
      services: [
        service("web", {
          ports: [fixedPort(8080)],
          networks: ["app"],
        }),
      ],
      containers: [container({ ports: [runtimePort(8080)] })],
      networks: [network("app", "media_app", ["10.0.0.1/24"])],
      runtimeNetworks: [runtimeNetwork("other", "other", ["10.0.0.128/25"])],
    });
    deepFreeze(input);

    expect(() => evaluateConflictValidation(input)).not.toThrow();
    expect(Object.isFrozen(input.desired.services)).toBe(true);
  });

  it("projects the same decision, owners, manual guidance, and limitations to human text", () => {
    const result = evaluateConflictValidation(
      validationInput({
        services: [service("web", { ports: [fixedPort(8080)] })],
        containers: [container({ name: "other", ports: [runtimePort(8080)] })],
      }),
    );

    const lines = formatConflictValidationText(result);

    expect(lines[0]).toBe("Conflict validation: BLOCKED");
    expect(lines.join("\n")).toContain("runtime container other");
    expect(lines.join("\n")).toContain("Manual resolution:");
    expect(lines.join("\n")).toContain("POINT_IN_TIME_SNAPSHOT");
  });
});
