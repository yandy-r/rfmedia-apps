import { describe, expect, it } from "vitest";
import type {
  ConflictValidationScope,
  DesiredServiceProjection,
  RuntimeContainerProjection,
} from "../types/validation.js";
import type { EvaluationBudget } from "./conflict-evaluator-shared.js";
import { evaluatePorts } from "./conflict-port-evaluator.js";

describe("conflict port evaluator", () => {
  it("evaluates desired and runtime port claims behind the aggregate facade", () => {
    const services: readonly DesiredServiceProjection[] = [
      {
        project: "media",
        service: "web",
        ports: [
          {
            kind: "port",
            origin: "desired",
            project: "media",
            service: "web",
            family: "ipv4",
            hostIp: "0.0.0.0",
            protocol: "tcp",
            allocation: { mode: "fixed", published: { start: 8080, end: 8080 } },
          },
        ],
        mounts: [],
        networks: [],
        dependencies: [],
      },
    ];
    const containers: readonly RuntimeContainerProjection[] = [
      {
        id: "runtime-id",
        name: "other",
        ports: [
          {
            kind: "port",
            origin: "runtime",
            containerId: "runtime-id",
            containerName: "other",
            family: "ipv4",
            hostIp: "127.0.0.1",
            protocol: "tcp",
            published: { start: 8080, end: 8080 },
          },
        ],
        mounts: [],
      },
    ];
    const scope: ConflictValidationScope = {
      project: "media",
      services: ["web"],
      profiles: ["all"],
    };
    const budget: EvaluationBudget = { comparisonWork: 0, findings: 0 };

    expect(evaluatePorts(services, containers, scope, budget).findings).toMatchObject([
      { code: "PORT_BINDING_CONFLICT", kind: "port", origin: "runtime" },
    ]);
  });
});
