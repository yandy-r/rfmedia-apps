import { describe, expect, it, vi } from "vitest";

import {
  type ConflictEvidenceAdapterDependencies,
  readCanonicalComposeConfigEvidence,
} from "./docker-conflict-evidence.js";

describe("Docker conflict evidence adapter", () => {
  it("fingerprints the complete parsed Compose payload without retaining resolved secrets", async () => {
    let secret = "first-secret-canary";
    const dependencies = {
      defaultTimeoutMs: 300_000,
      execDocker: vi.fn(),
      execDockerCompose: vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify({
          name: "fixture",
          services: {
            web: {
              image: "example/web:latest",
              environment: { API_TOKEN: secret },
            },
          },
        }),
        stderr: "",
        success: true,
      })),
      filterToolOutput: (lines: string[]) => lines,
      safeComposePaths: vi.fn(async (paths: readonly string[]) => [...paths]),
      safeEnvironmentFilePath: vi.fn(async (path: string) => path),
    } satisfies ConflictEvidenceAdapterDependencies;

    const first = await readCanonicalComposeConfigEvidence(dependencies, "/project/compose.yml");
    secret = "second-secret-canary";
    const second = await readCanonicalComposeConfigEvidence(dependencies, "/project/compose.yml");

    expect(first.config).toEqual(second.config);
    expect(first.resolvedConfigFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.resolvedConfigFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.resolvedConfigFingerprint).not.toBe(second.resolvedConfigFingerprint);
    expect(JSON.stringify(first)).not.toContain("first-secret-canary");
    expect(JSON.stringify(second)).not.toContain("second-secret-canary");
  });

  it("preserves anonymous and unsupported mounts as bounded backup evidence", async () => {
    const dependencies = {
      defaultTimeoutMs: 300_000,
      execDocker: vi.fn(),
      execDockerCompose: vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify({
          name: "fixture",
          services: {
            web: {
              volumes: [
                {
                  type: "volume",
                  target: "/anonymous",
                  read_only: false,
                },
                {
                  type: "cluster",
                  source: "remote-data",
                  target: "/unsupported",
                  read_only: true,
                },
              ],
            },
          },
        }),
        stderr: "",
        success: true,
      })),
      filterToolOutput: (lines: string[]) => lines,
      safeComposePaths: vi.fn(async (paths: readonly string[]) => [...paths]),
      safeEnvironmentFilePath: vi.fn(async (path: string) => path),
    } satisfies ConflictEvidenceAdapterDependencies;

    const evidence = await readCanonicalComposeConfigEvidence(dependencies, "/project/compose.yml");

    expect(evidence.config.services["web"]).toMatchObject({
      volumes: [
        {
          type: "volume",
          target: "/anonymous",
          read_only: false,
        },
      ],
      unsupported_volumes: [
        {
          type: "cluster",
          source: "remote-data",
          target: "/unsupported",
          read_only: true,
        },
      ],
    });
  });
});
