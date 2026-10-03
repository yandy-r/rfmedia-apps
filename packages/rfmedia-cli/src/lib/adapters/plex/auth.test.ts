import { inspect } from "node:util";

import { describe, expect, expectTypeOf, it } from "vitest";

import { createPlexConnectionSettings } from "./types.js";
import {
  StaticPlexTokenProvider,
  type PlexAuthFailureAction,
  type PlexTokenProvider,
} from "./auth.js";

function createProvider(token: string): StaticPlexTokenProvider {
  const connection = createPlexConnectionSettings({
    origin: "http://localhost:32400",
    token,
    clientIdentifier: "rfmedia-test-client",
  });
  return new StaticPlexTokenProvider(connection);
}

describe("StaticPlexTokenProvider", () => {
  it.each([
    "legacy-token-value",
    "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJwbGV4LXVzZXIifQ.signature",
    " opaque value ",
  ])("returns an opaque credential byte-for-byte unchanged", async (token) => {
    const provider = createProvider(token);

    await expect(provider.getToken()).resolves.toBe(token);
    expectTypeOf(provider).toMatchTypeOf<PlexTokenProvider>();
  });

  it.each(["", "prefix\u0000suffix", "prefix\nsuffix", "prefix\u007fsuffix", "prefix\u0085suffix"])(
    "rejects an empty or control-character credential without disclosing it: %j",
    async (token) => {
      const provider = createProvider(token);

      let failure: unknown;
      try {
        await provider.getToken();
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(TypeError);
      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : String(failure);
      expect(message).toMatch(
        /^Plex credential (?:must not be empty|contains a control character)$/,
      );
      if (token.length > 0) {
        expect(message).not.toContain(token);
        expect(inspect(failure)).not.toContain(token);
      }
    },
  );

  it("keeps credential material out of inspectable and serializable provider state", async () => {
    const token = "secret.jwt-looking.value";
    const provider = createProvider(token);

    expect(Object.isFrozen(provider)).toBe(true);
    expect(Reflect.ownKeys(provider)).toEqual([]);
    expect(JSON.stringify(provider)).toBe("{}");
    expect(inspect(provider)).not.toContain(token);
    expect(await provider.getToken()).toBe(token);
  });

  it.each([401, 403, 422, 429, 498])(
    "never authorizes authentication recovery for status %i",
    async (status) => {
      const provider = createProvider("opaque-token");

      await expect(provider.handleAuthFailure(status)).resolves.toBe("fail");
      expectTypeOf(await provider.handleAuthFailure(status)).toEqualTypeOf<"fail">();
      expectTypeOf<PlexAuthFailureAction>().toEqualTypeOf<"retry" | "fail">();
    },
  );
});
