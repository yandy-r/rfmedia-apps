import { afterEach, describe, expect, it } from "vitest";

import { deferSignal, takeDeferredSignal } from "./deferred-signal.js";

afterEach(() => {
  takeDeferredSignal();
});

describe("deferred signal broker", () => {
  it("retains the first signal and consumes it exactly once", () => {
    deferSignal("SIGTERM");
    deferSignal("SIGINT");

    expect(takeDeferredSignal()).toBe("SIGTERM");
    expect(takeDeferredSignal()).toBeUndefined();
  });
});
