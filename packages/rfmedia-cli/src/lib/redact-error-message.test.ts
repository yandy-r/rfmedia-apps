import { describe, expect, it } from "vitest";

import { redactErrorMessage } from "./redact-error-message.js";

describe("redactErrorMessage", () => {
  it("redacts supplied values, URL credentials, and query secrets", () => {
    expect(
      redactErrorMessage(
        new Error(
          "secret at https://user:pass@example.test/path?api_key=query-secret&token=token-secret",
        ),
        ["secret"],
      ),
    ).toBe(
      "[REDACTED] at https://[REDACTED]@example.test/path?api_key=[REDACTED]&token=[REDACTED]",
    );
  });

  it("replaces terminal controls and bidi controls", () => {
    expect(redactErrorMessage("safe\u001b[31m\u202Eunsafe")).toBe("safe�[31m�unsafe");
  });
});
