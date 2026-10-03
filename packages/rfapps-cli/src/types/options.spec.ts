import { describe, expect, it } from "vitest";

import { getEnvToolExecConfig } from "./options.js";

describe("getEnvToolExecConfig", () => {
  it("prefers CLI dotenvx override over config defaults", () => {
    expect(
      getEnvToolExecConfig(
        { useDotenvx: "/tmp/custom.env" },
        {
          envFile: "/repo/.env.local",
          envTool: { tool: "dotenvx" },
        },
      ),
    ).toEqual({ tool: "dotenvx", envFile: "/tmp/custom.env" });
  });

  it("uses configured env tool when CLI flags are absent", () => {
    expect(
      getEnvToolExecConfig(
        {},
        {
          envFile: "/repo/.env.local",
          envTool: { tool: "dotenvx" },
        },
      ),
    ).toEqual({ tool: "dotenvx", envFile: "/repo/.env.local" });
  });

  it("returns undefined when config env tool is none", () => {
    expect(
      getEnvToolExecConfig(
        {},
        {
          envFile: "/repo/.env",
          envTool: { tool: "none" },
        },
      ),
    ).toBeUndefined();
  });
});
