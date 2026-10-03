import { describe, expect, it } from "vitest";
import type {
  DesiredNetworkProjection,
  DesiredServiceProjection,
  RuntimeNetworkProjection,
} from "../types/validation.js";
import type { EvaluationBudget } from "./conflict-evaluator-shared.js";
import { evaluateNetworks } from "./conflict-network-evaluator.js";

describe("conflict network evaluator", () => {
  it("evaluates desired and runtime subnet claims behind the aggregate facade", () => {
    const services: readonly DesiredServiceProjection[] = [
      {
        project: "media",
        service: "web",
        ports: [],
        mounts: [],
        networks: ["app"],
        dependencies: [],
      },
    ];
    const desired: readonly DesiredNetworkProjection[] = [
      {
        key: "app",
        name: "media_app",
        external: false,
        driver: "bridge",
        subnets: ["10.0.0.0/24"],
      },
    ];
    const runtime: readonly RuntimeNetworkProjection[] = [
      {
        id: "runtime-id",
        name: "other",
        driver: "bridge",
        subnets: ["10.0.0.128/25"],
      },
    ];
    const budget: EvaluationBudget = { comparisonWork: 0, findings: 0 };

    expect(evaluateNetworks("media", services, desired, runtime, budget).findings).toMatchObject([
      { code: "NETWORK_SUBNET_CONFLICT", kind: "network", origin: "runtime" },
    ]);
  });
});
