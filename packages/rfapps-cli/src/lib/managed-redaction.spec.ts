import { describe, expect, it } from "vitest";

import { redactManagedMessage } from "./managed-redaction.js";

describe("managed lifecycle message redaction", () => {
  it.each([
    ["Bearer", "request failed Bearer bearer-canary", "bearer-canary"],
    ["credentialed URL", "request https://user:url-canary@example.test failed", "url-canary"],
    ["password assignment", "database password=password-canary failed", "password-canary"],
    ["token assignment", "registry token: token-canary failed", "token-canary"],
    ["secret assignment", "provider secret is secret-canary", "secret-canary"],
    ["API key assignment", "provider API key=api-canary failed", "api-canary"],
    ["database password env", "DB_PASSWORD=db-canary", "db-canary"],
    ["application token env", "PLEX_TOKEN=token-canary", "token-canary"],
    ["AWS secret env", "AWS_SECRET_ACCESS_KEY=secret-canary", "secret-canary"],
    ["OpenAI API key env", "OPENAI_API_KEY=api-canary", "api-canary"],
  ])("redacts %s evidence", (_name, message, canary) => {
    const redacted = redactManagedMessage(message);

    expect(redacted).not.toContain(canary);
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts before applying the output bound", () => {
    const canary = "bounded-canary";
    const redacted = redactManagedMessage(`password=${canary} ${"x".repeat(100)}`, 32);

    expect(redacted).not.toContain(canary);
    expect(redacted.length).toBeLessThanOrEqual(32);
  });
});
