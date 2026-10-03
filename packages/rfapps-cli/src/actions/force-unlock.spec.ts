import { beforeEach, describe, expect, it, vi } from "vitest";

const commonMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  isMachineFormat: vi.fn((format: string) => format !== "text"),
  logInfo: vi.fn(),
  logSuccess: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@rfmedia/common", () => commonMocks);

import { executeForceUnlock, type ForceUnlockDependencies } from "./force-unlock.js";
import type { StateLockInspection } from "../lib/state-lock.js";

const activeInspection: StateLockInspection = {
  status: "active",
  path: "/tmp/rfapps/lock",
  identity: { dev: 1, ino: 2 },
  metadata: {
    operation: "deploy",
    who: "operator@host",
    when: "2026-07-24T12:00:00.000Z",
    lockId: "123e4567-e89b-42d3-a456-426614174000",
  },
  entry: {
    name: "123e4567-e89b-42d3-a456-426614174000",
    identity: { dev: 3, ino: 4 },
    fingerprint: "metadata-fingerprint",
  },
};

function dependencies(inspection: StateLockInspection = activeInspection): ForceUnlockDependencies {
  return {
    inspect: vi.fn(async () => inspection),
    forceUnlock: vi.fn(async () => true),
    confirm: vi.fn(async () => true),
    output: vi.fn(async () => undefined),
  };
}

describe("force-unlock action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats a missing lock as a successful no-op", async () => {
    const deps = dependencies({ status: "missing", path: "/tmp/rfapps/lock" });

    await expect(executeForceUnlock({}, deps)).resolves.toMatchObject({
      previousStatus: "missing",
      unlocked: false,
      cancelled: false,
    });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.forceUnlock).not.toHaveBeenCalled();
  });

  it("warns and preserves the lock when confirmation is declined", async () => {
    const deps = dependencies();
    vi.mocked(deps.confirm).mockResolvedValue(false);

    await expect(executeForceUnlock({}, deps)).resolves.toMatchObject({
      previousStatus: "active",
      unlocked: false,
      cancelled: true,
    });
    expect(commonMocks.logWarn).toHaveBeenCalledWith(expect.stringContaining("DANGER"));
    expect(deps.forceUnlock).not.toHaveBeenCalled();
  });

  it("uses the inspected identity and skips confirmation with --yes", async () => {
    const deps = dependencies();

    await expect(executeForceUnlock({ yes: true }, deps)).resolves.toMatchObject({
      unlocked: true,
      cancelled: false,
    });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.forceUnlock).toHaveBeenCalledWith(activeInspection);
  });

  it("reports dry-run recovery without confirmation or removal", async () => {
    const deps = dependencies();

    await expect(executeForceUnlock({ dryRun: true, output: "json" }, deps)).resolves.toMatchObject(
      {
        dryRun: true,
        unlocked: false,
        cancelled: false,
      },
    );
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.forceUnlock).not.toHaveBeenCalled();
    expect(deps.output).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({ dryRun: true, unlocked: false }),
    );
  });

  it("requires explicit --yes for machine-format recovery", async () => {
    const deps = dependencies();

    await expect(executeForceUnlock({ output: "json" }, deps)).rejects.toMatchObject({
      name: "InvalidArgumentError",
    });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.forceUnlock).not.toHaveBeenCalled();
  });
});
