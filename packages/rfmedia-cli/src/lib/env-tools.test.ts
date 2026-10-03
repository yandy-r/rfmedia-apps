import { describe, expect, it } from "vitest";
import { buildEnvCommand } from "./env-tools.js";

describe("buildEnvCommand", () => {
  it("builds the dotenvx prefix", () => {
    expect(buildEnvCommand("dotenvx", ".env.local")).toEqual({
      command: "dotenvx",
      args: ["run", "-q", "-f", ".env.local", "--"],
    });
  });

  it("disables 1Password output masking so captured stdout stays intact", () => {
    expect(buildEnvCommand("op", ".env.local")).toEqual({
      command: "op",
      args: ["run", "--no-masking", "--env-file", ".env.local", "--"],
    });
  });
});
