import { describe, expect, it } from "vitest";

import { sanitizeMessage } from "./http.js";

/** RIGHT-TO-LEFT OVERRIDE, written as a codepoint so the source stays readable. */
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);

describe("sanitizeMessage", () => {
  it("redacts refresh_token, which the previous word-boundary anchors missed", () => {
    expect(sanitizeMessage(new Error("plex.tv rejected refresh_token=rt-abc123"), [])).toBe(
      "plex.tv rejected [REDACTED]",
    );
  });

  it("redacts auth_token, which the previous word-boundary anchors missed", () => {
    expect(sanitizeMessage(new Error("auth_token=at-xyz789 was refused"), [])).toBe(
      "[REDACTED] was refused",
    );
  });

  it("removes a previous credential still supplied in the secrets array after rotation", () => {
    expect(
      sanitizeMessage(new Error("PMS rejected credential eyJprev.sig for origin"), [
        "eyJprev.sig",
        "eyJcurrent.sig",
      ]),
    ).toBe("PMS rejected credential [REDACTED] for origin");
  });

  it("strips bidirectional override characters from server-influenced text", () => {
    expect(sanitizeMessage(new Error(`${RIGHT_TO_LEFT_OVERRIDE}Plex reported a failure`), [])).toBe(
      "Plex reported a failure",
    );
  });
});
