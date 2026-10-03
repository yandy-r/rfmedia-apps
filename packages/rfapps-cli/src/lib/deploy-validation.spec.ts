import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DockerEvidenceError,
  getCanonicalComposeConfigEvidence,
  getConflictRuntimeContainers,
  getConflictRuntimeNetworks,
  getConflictRuntimeVolumes,
} from "./docker.js";
import { captureEffectiveEnvironment } from "./env-tools.js";
import { dockerAuthorityFingerprintFromEnvironment } from "./identity.js";
import {
  canonicalizeDeployEnvTool,
  revalidateDeployBinding,
  runDeployValidation,
} from "./deploy-validation.js";

vi.mock("./docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./docker.js")>();
  return {
    ...actual,
    getCanonicalComposeConfigEvidence: vi.fn(),
    getConflictRuntimeContainers: vi.fn(),
    getConflictRuntimeNetworks: vi.fn(),
    getConflictRuntimeVolumes: vi.fn(),
  };
});
vi.mock("./env-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env-tools.js")>();
  return {
    ...actual,
    captureEffectiveEnvironment: vi.fn(),
  };
});
vi.mock("./identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity.js")>();
  return {
    ...actual,
    dockerAuthorityFingerprintFromEnvironment: vi.fn(),
  };
});

describe("deploy validation coordinator", () => {
  let root: string;
  let invocationDir: string;
  let projectDir: string;
  let composePath: string;
  let composeEnvPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), "rfapps-deploy-validation-"));
    invocationDir = join(root, "invocation");
    projectDir = join(root, "project");
    await mkdir(invocationDir);
    await mkdir(projectDir);
    composePath = join(projectDir, "compose.yml");
    composeEnvPath = join(projectDir, ".env.local");
    await writeFile(composePath, "services: {}\n", "utf8");
    await writeFile(composeEnvPath, "PLAIN=compose\n", "utf8");

    vi.mocked(captureEffectiveEnvironment).mockResolvedValue({ PATH: "/usr/bin" });
    vi.mocked(dockerAuthorityFingerprintFromEnvironment).mockResolvedValue("authority-fingerprint");
    vi.mocked(getConflictRuntimeContainers).mockResolvedValue([]);
    vi.mocked(getConflictRuntimeNetworks).mockResolvedValue([]);
    vi.mocked(getConflictRuntimeVolumes).mockResolvedValue([]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("retains canonical scope, completed lanes, and findings when one evidence lane fails", async () => {
    vi.mocked(getCanonicalComposeConfigEvidence).mockResolvedValue({
      resolvedConfigFingerprint: "resolved-compose-fingerprint",
      config: {
        name: "fixture",
        services: {
          api: {
            name: "api",
            depends_on: [],
            ports: [
              {
                target: "80",
                published: "8080",
                host_ip: "0.0.0.0",
                protocol: "tcp",
                mode: "ingress",
              },
            ],
            volumes: [],
            networks: ["appnet"],
          },
          web: {
            name: "web",
            depends_on: [],
            ports: [
              {
                target: "80",
                published: "8080",
                host_ip: "0.0.0.0",
                protocol: "tcp",
                mode: "ingress",
              },
            ],
            volumes: [],
            networks: ["appnet"],
          },
        },
        volumes: {},
        networks: {
          appnet: {
            name: "fixture_appnet",
            external: false,
            driver: "bridge",
            ipam: { config: [{ subnet: "10.0.0.0/24" }] },
          },
        },
      },
    });
    vi.mocked(getConflictRuntimeNetworks).mockResolvedValue([
      {
        id: "b".repeat(64),
        name: "other-network",
        driver: "bridge",
        subnets: ["10.0.0.128/25"],
      },
    ]);
    vi.mocked(getConflictRuntimeContainers).mockRejectedValue(
      new DockerEvidenceError(
        "Running Docker container evidence could not be collected safely.",
        "CONTAINER_SNAPSHOT_UNAVAILABLE",
        "containers",
      ),
    );

    const outcome = await runDeployValidation(
      composePath,
      composeEnvPath,
      ["core"],
      ["web", "api"],
      undefined,
    );

    expect(outcome.effectiveServices).toEqual(["api", "web"]);
    expect(outcome.result).toMatchObject({
      status: "inconclusive",
      scope: {
        project: "fixture",
        services: ["api", "web"],
        profiles: ["core"],
      },
      error: {
        code: "CONTAINER_SNAPSHOT_UNAVAILABLE",
        check: "containers",
        message: "Running Docker container evidence could not be collected safely.",
      },
      summary: {
        total: 2,
        errors: 2,
        ports: 1,
        networks: 1,
      },
    });
    expect(outcome.result.conflicts).toEqual([
      expect.objectContaining({
        code: "PORT_BINDING_CONFLICT",
        kind: "port",
      }),
      expect.objectContaining({
        code: "NETWORK_SUBNET_CONFLICT",
        kind: "network",
      }),
    ]);
    expect(outcome.result.checks).toEqual([
      expect.objectContaining({ id: "compose", status: "passed", resources: 3 }),
      expect.objectContaining({ id: "scope", status: "passed", resources: 2 }),
      expect.objectContaining({ id: "authority", status: "passed", resources: 2 }),
      expect.objectContaining({
        id: "containers",
        status: "failed",
        resources: 0,
        failure: expect.objectContaining({ code: "CONTAINER_SNAPSHOT_UNAVAILABLE" }),
      }),
      expect.objectContaining({ id: "volumes", status: "passed", resources: 0 }),
      expect.objectContaining({ id: "networks", status: "passed", resources: 2 }),
      expect.objectContaining({ id: "normalization", status: "passed" }),
    ]);
  });

  it("retains resolved scope and completed lanes when Docker authority is unavailable", async () => {
    vi.mocked(getCanonicalComposeConfigEvidence).mockResolvedValue({
      resolvedConfigFingerprint: "resolved-compose-fingerprint",
      config: {
        name: "fixture",
        services: {
          api: {
            name: "api",
            depends_on: [],
            ports: [
              {
                target: "80",
                published: "8080",
                host_ip: "0.0.0.0",
                protocol: "tcp",
              },
            ],
            volumes: [],
            networks: [],
          },
          web: {
            name: "web",
            depends_on: [],
            ports: [
              {
                target: "80",
                published: "8080",
                host_ip: "0.0.0.0",
                protocol: "tcp",
              },
            ],
            volumes: [],
            networks: [],
          },
        },
        volumes: {},
        networks: {},
      },
    });
    vi.mocked(dockerAuthorityFingerprintFromEnvironment).mockRejectedValue(
      new Error("authority probe failed"),
    );

    const outcome = await runDeployValidation(
      composePath,
      composeEnvPath,
      ["core"],
      ["web", "api"],
      undefined,
    );

    expect(outcome.effectiveServices).toEqual(["api", "web"]);
    expect(outcome.binding).toMatchObject({
      projectName: "fixture",
      authorityFingerprint: "",
    });
    expect(outcome.result).toMatchObject({
      status: "inconclusive",
      scope: {
        project: "fixture",
        services: ["api", "web"],
        profiles: ["core"],
      },
      error: {
        code: "DOCKER_AUTHORITY_UNAVAILABLE",
        check: "authority",
      },
      summary: {
        total: 1,
        errors: 1,
        ports: 1,
      },
    });
    expect(outcome.result.conflicts).toEqual([
      expect.objectContaining({ code: "PORT_BINDING_CONFLICT", origin: "desired" }),
    ]);
    expect(outcome.result.checks).toEqual([
      expect.objectContaining({ id: "compose", status: "passed", resources: 2 }),
      expect.objectContaining({ id: "scope", status: "passed", resources: 2 }),
      expect.objectContaining({
        id: "authority",
        status: "failed",
        resources: 0,
        failure: expect.objectContaining({ code: "DOCKER_AUTHORITY_UNAVAILABLE" }),
      }),
      expect.objectContaining({ id: "containers", status: "passed", resources: 0 }),
      expect.objectContaining({ id: "volumes", status: "passed", resources: 0 }),
      expect.objectContaining({ id: "networks", status: "passed", resources: 0 }),
      expect.objectContaining({ id: "normalization", status: "passed" }),
    ]);
    expect(getConflictRuntimeContainers).toHaveBeenCalledOnce();
    expect(getConflictRuntimeNetworks).toHaveBeenCalledOnce();
    expect(getConflictRuntimeVolumes).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "unsupported",
      volumes: [],
      unsupportedVolumes: [
        {
          type: "cluster",
          source: "remote-data",
          target: "/data",
          read_only: false,
        },
      ],
    },
    {
      name: "missing-source bind",
      volumes: [{ type: "bind" as const, target: "/data", read_only: false }],
      unsupportedVolumes: undefined,
    },
    {
      name: "missing-source volume",
      volumes: [{ type: "volume" as const, target: "/data", read_only: false }],
      unsupportedVolumes: undefined,
    },
  ])(
    "fails closed before runtime evidence for a $name mount",
    async ({ volumes, unsupportedVolumes }) => {
      vi.mocked(getCanonicalComposeConfigEvidence).mockResolvedValue({
        resolvedConfigFingerprint: "resolved-compose-fingerprint",
        config: {
          name: "fixture",
          services: {
            web: {
              name: "web",
              depends_on: [],
              ports: [],
              volumes,
              ...(unsupportedVolumes === undefined
                ? {}
                : { unsupported_volumes: unsupportedVolumes }),
              networks: [],
            },
          },
          volumes: {},
          networks: {},
        },
      });

      const outcome = await runDeployValidation(
        composePath,
        composeEnvPath,
        ["core"],
        ["web"],
        undefined,
      );

      expect(outcome.result).toMatchObject({
        status: "inconclusive",
        error: {
          code: "UNSUPPORTED_RESOURCE_SHAPE",
          check: "normalization",
        },
      });
      expect(getConflictRuntimeContainers).not.toHaveBeenCalled();
      expect(getConflictRuntimeNetworks).not.toHaveBeenCalled();
      expect(getConflictRuntimeVolumes).not.toHaveBeenCalled();
    },
  );

  it("does not infer missing external volumes from an unavailable volume lane", async () => {
    vi.mocked(getCanonicalComposeConfigEvidence).mockResolvedValue({
      resolvedConfigFingerprint: "resolved-compose-fingerprint",
      config: {
        name: "fixture",
        services: {
          web: {
            name: "web",
            depends_on: [],
            ports: [],
            volumes: [
              {
                type: "volume",
                source: "external_data",
                target: "/data",
                read_only: false,
              },
              {
                type: "bind",
                source: "/srv/data",
                target: "/data",
                read_only: true,
              },
            ],
            networks: [],
          },
        },
        volumes: {
          external_data: {
            name: "shared-data",
            external: true,
            driver: "local",
            driver_opts: {},
          },
        },
        networks: {},
      },
    });
    vi.mocked(getConflictRuntimeVolumes).mockRejectedValue(
      new DockerEvidenceError(
        "Docker volume evidence was unavailable",
        "VOLUME_SNAPSHOT_UNAVAILABLE",
        "volumes",
      ),
    );

    const outcome = await runDeployValidation(
      composePath,
      composeEnvPath,
      ["core"],
      ["web"],
      undefined,
    );

    expect(outcome.result).toMatchObject({
      status: "inconclusive",
      error: {
        code: "VOLUME_SNAPSHOT_UNAVAILABLE",
        check: "volumes",
      },
      summary: {
        total: 1,
        errors: 1,
        volumes: 1,
      },
    });
    expect(outcome.result.conflicts.map((finding) => finding.code)).toEqual([
      "VOLUME_TARGET_CONFLICT",
    ]);
    expect(outcome.result.conflicts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EXTERNAL_VOLUME_MISSING" }),
        expect.objectContaining({ code: "VOLUME_RUNTIME_CONFLICT" }),
      ]),
    );
  });

  it("does not start evidence lanes after the shared validation deadline", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(getCanonicalComposeConfigEvidence).mockImplementation(async () => {
      now += 300_000;
      return {
        resolvedConfigFingerprint: "resolved-compose-fingerprint",
        config: {
          name: "fixture",
          services: {
            web: {
              name: "web",
              depends_on: [],
              ports: [],
              volumes: [],
              networks: [],
            },
          },
          volumes: {},
          networks: {},
        },
      };
    });

    const outcome = await runDeployValidation(
      composePath,
      composeEnvPath,
      ["core"],
      ["web"],
      undefined,
    );

    expect(getCanonicalComposeConfigEvidence).toHaveBeenCalledWith(
      composePath,
      expect.objectContaining({
        deadline: 310_000,
        timeout: 300_000,
        maxRetries: 1,
      }),
    );
    expect(dockerAuthorityFingerprintFromEnvironment).not.toHaveBeenCalled();
    expect(getConflictRuntimeContainers).not.toHaveBeenCalled();
    expect(getConflictRuntimeNetworks).not.toHaveBeenCalled();
    expect(getConflictRuntimeVolumes).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({
      status: "inconclusive",
      error: { code: "EVIDENCE_LIMIT_EXCEEDED", check: "authority" },
    });
  });

  it("preserves the canonical project when effective closure resolution fails", async () => {
    vi.mocked(getCanonicalComposeConfigEvidence).mockResolvedValue({
      resolvedConfigFingerprint: "resolved-compose-fingerprint",
      config: {
        name: "fixture",
        services: {
          web: {
            name: "web",
            depends_on: ["missing"],
            ports: [],
            volumes: [],
            networks: [],
          },
        },
        volumes: {},
        networks: {},
      },
    });

    const outcome = await runDeployValidation(
      composePath,
      composeEnvPath,
      ["core"],
      ["web"],
      undefined,
    );

    expect(outcome.result).toMatchObject({
      status: "inconclusive",
      scope: { project: "fixture", services: ["web"] },
      error: { code: "EFFECTIVE_SCOPE_UNAVAILABLE", check: "scope" },
    });
    expect(outcome.result.checks).toEqual([
      expect.objectContaining({ id: "compose", status: "passed" }),
      expect.objectContaining({ id: "scope", status: "failed" }),
    ]);
  });

  it("preserves canonical scope when desired projection fails", async () => {
    vi.mocked(getCanonicalComposeConfigEvidence).mockResolvedValue({
      resolvedConfigFingerprint: "resolved-compose-fingerprint",
      config: {
        name: "fixture",
        services: {
          web: {
            name: "web",
            depends_on: [],
            ports: ["8080:80"],
            volumes: [],
            networks: [],
          },
        },
        volumes: {},
        networks: {},
      },
    });

    const outcome = await runDeployValidation(
      composePath,
      composeEnvPath,
      ["core"],
      ["web"],
      undefined,
    );

    expect(outcome.result).toMatchObject({
      status: "inconclusive",
      scope: { project: "fixture", services: ["web"] },
      error: { code: "UNSUPPORTED_RESOURCE_SHAPE", check: "normalization" },
    });
    expect(outcome.result.checks).toEqual([
      expect.objectContaining({ id: "compose", status: "passed" }),
      expect.objectContaining({ id: "scope", status: "passed" }),
      expect.objectContaining({ id: "normalization", status: "failed" }),
    ]);
  });

  it("preserves canonical scope when the Compose file cannot be fingerprinted", async () => {
    vi.mocked(getCanonicalComposeConfigEvidence).mockImplementation(async () => {
      await rm(composePath);
      return {
        resolvedConfigFingerprint: "resolved-compose-fingerprint",
        config: {
          name: "fixture",
          services: {
            web: {
              name: "web",
              depends_on: [],
              ports: [],
              volumes: [],
              networks: [],
            },
          },
          volumes: {},
          networks: {},
        },
      };
    });

    const outcome = await runDeployValidation(
      composePath,
      composeEnvPath,
      ["core"],
      ["web"],
      undefined,
    );

    expect(outcome.result).toMatchObject({
      status: "inconclusive",
      scope: { project: "fixture", services: ["web"] },
      error: { code: "VALIDATION_INPUT_CHANGED", check: "revalidation" },
    });
    expect(outcome.result.checks).toEqual([
      expect.objectContaining({ id: "compose", status: "passed" }),
      expect.objectContaining({ id: "scope", status: "passed" }),
      expect.objectContaining({ id: "revalidation", status: "failed" }),
    ]);
  });

  it("treats an omitted host_ip as both IPv4 and IPv6 wildcard claims", async () => {
    vi.mocked(getCanonicalComposeConfigEvidence).mockResolvedValue({
      resolvedConfigFingerprint: "resolved-compose-fingerprint",
      config: {
        name: "fixture",
        services: {
          web: {
            name: "web",
            depends_on: [],
            ports: [
              {
                target: "80",
                published: "8080",
                protocol: "tcp",
              },
            ],
            volumes: [],
            networks: [],
          },
        },
        volumes: {},
        networks: {},
      },
    });
    vi.mocked(getConflictRuntimeContainers).mockResolvedValue([
      {
        id: "a".repeat(64),
        name: "ipv6-owner",
        ports: [
          {
            kind: "port",
            origin: "runtime",
            containerId: "a".repeat(64),
            containerName: "ipv6-owner",
            family: "ipv6",
            hostIp: "::",
            protocol: "tcp",
            published: { start: 8080, end: 8080 },
          },
        ],
        mounts: [],
      },
    ]);

    const outcome = await runDeployValidation(
      composePath,
      composeEnvPath,
      ["core"],
      ["web"],
      undefined,
    );

    expect(outcome.result.status).toBe("blocked");
    expect(outcome.result.conflicts).toEqual([
      expect.objectContaining({
        code: "PORT_BINDING_CONFLICT",
        origin: "runtime",
        resource: expect.objectContaining({
          family: "ipv6",
          hostIp: "::",
          published: { start: 8080, end: 8080 },
        }),
      }),
    ]);
  });

  it("revalidates against the complete parsed Compose payload fingerprint", async () => {
    const config = {
      name: "fixture",
      services: {
        web: {
          name: "web",
          depends_on: [],
          ports: [],
          volumes: [],
          networks: [],
        },
      },
      volumes: {},
      networks: {},
    } as const;
    vi.mocked(getCanonicalComposeConfigEvidence).mockResolvedValue({
      config,
      resolvedConfigFingerprint: "complete-payload-before",
    });
    const outcome = await runDeployValidation(
      composePath,
      composeEnvPath,
      ["core"],
      ["web"],
      undefined,
    );
    vi.mocked(getCanonicalComposeConfigEvidence).mockResolvedValue({
      config,
      resolvedConfigFingerprint: "complete-payload-after",
    });

    await expect(revalidateDeployBinding(outcome.binding)).resolves.toEqual({
      code: "VALIDATION_INPUT_CHANGED",
      check: "revalidation",
      message: "The effective Compose inputs changed after pre-deploy validation.",
    });
  });

  it.each(["dotenvx", "op"] as const)(
    "pins a relative %s provider file to the invocation cwd before using project cwd",
    async (tool) => {
      const invocationProvider = join(invocationDir, "secrets.env");
      const projectProvider = join(projectDir, "secrets.env");
      await writeFile(invocationProvider, "SOURCE=invocation\n", "utf8");
      await writeFile(projectProvider, "SOURCE=project\n", "utf8");
      vi.mocked(getCanonicalComposeConfigEvidence).mockResolvedValue({
        resolvedConfigFingerprint: "resolved-compose-fingerprint",
        config: {
          name: "fixture",
          services: {
            web: {
              name: "web",
              depends_on: [],
              ports: [],
              volumes: [],
              networks: [],
            },
          },
          volumes: {},
          networks: {},
        },
      });

      const envTool = await canonicalizeDeployEnvTool(
        { tool, envFile: "secrets.env" },
        invocationDir,
      );
      await runDeployValidation(composePath, composeEnvPath, ["core"], ["web"], envTool);

      expect(envTool).toEqual({ tool, envFile: invocationProvider });
      expect(captureEffectiveEnvironment).toHaveBeenCalledWith({
        tool,
        envFile: invocationProvider,
        cwd: projectDir,
      });
      expect(captureEffectiveEnvironment).not.toHaveBeenCalledWith(
        expect.objectContaining({ envFile: projectProvider }),
      );
    },
  );
});
