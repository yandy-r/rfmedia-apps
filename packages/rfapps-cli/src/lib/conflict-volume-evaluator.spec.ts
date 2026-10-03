import { describe, expect, it } from "vitest";
import type { DesiredServiceProjection, DesiredVolumeProjection } from "../types/validation.js";
import type { EvaluationBudget } from "./conflict-evaluator-shared.js";
import { evaluateVolumes } from "./conflict-volume-evaluator.js";

describe("conflict volume evaluator", () => {
  it("evaluates required external volumes behind the aggregate facade", () => {
    const services: readonly DesiredServiceProjection[] = [
      {
        project: "media",
        service: "web",
        ports: [],
        mounts: [
          {
            type: "volume",
            source: "data",
            target: "/data",
            readOnly: false,
          },
        ],
        networks: [],
        dependencies: [],
      },
    ];
    const volumes: readonly DesiredVolumeProjection[] = [
      {
        key: "data",
        name: "shared-data",
        external: true,
        driver: "local",
        driverOptions: {},
      },
    ];
    const budget: EvaluationBudget = { comparisonWork: 0, findings: 0 };

    expect(evaluateVolumes("media", services, volumes, [], true, budget)).toMatchObject([
      { code: "EXTERNAL_VOLUME_MISSING", kind: "volume", origin: "runtime" },
    ]);
  });
});
