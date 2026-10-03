import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createRotatingPlexCredentialCell,
  createStaticPlexCredentialCell,
  readPlexCredentialCell,
  rotatePlexCredentialCell,
} from "./credential-cell.js";

const BOUND_ORIGIN = "https://plex.example.com";
const FOREIGN_ORIGIN = "https://attacker.example.com";
const ISSUED_CREDENTIAL = "issued.jwt-looking.value";
const ROTATED_CREDENTIAL = "rotated.jwt-looking.value";

function captureFailure(release: () => unknown): unknown {
  try {
    release();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the credential cell to reject the release");
}

describe("Plex credential cell security", () => {
  it("releases the bound credential only for its bound origin", () => {
    const cell = createStaticPlexCredentialCell(BOUND_ORIGIN, ISSUED_CREDENTIAL);

    expect(readPlexCredentialCell(cell, BOUND_ORIGIN)).toBe(ISSUED_CREDENTIAL);

    const failure = captureFailure(() => readPlexCredentialCell(cell, FOREIGN_ORIGIN));
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toBe(
      "Plex credential cannot be used for a different origin",
    );
    expect(inspect(failure)).not.toContain(ISSUED_CREDENTIAL);
  });

  it("refuses to release a rotated credential for a foreign origin", () => {
    const cell = createRotatingPlexCredentialCell(BOUND_ORIGIN, ISSUED_CREDENTIAL);
    rotatePlexCredentialCell(cell, BOUND_ORIGIN, ROTATED_CREDENTIAL);

    const failure = captureFailure(() => readPlexCredentialCell(cell, FOREIGN_ORIGIN));
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toBe(
      "Plex credential cannot be used for a different origin",
    );
    expect(inspect(failure)).not.toContain(ISSUED_CREDENTIAL);
    expect(inspect(failure)).not.toContain(ROTATED_CREDENTIAL);
    expect(readPlexCredentialCell(cell, BOUND_ORIGIN)).toBe(ROTATED_CREDENTIAL);
  });

  it("refuses rotation of a static cell and keeps the configured credential", () => {
    const cell = createStaticPlexCredentialCell(BOUND_ORIGIN, ISSUED_CREDENTIAL);

    const failure = captureFailure(() =>
      rotatePlexCredentialCell(cell, BOUND_ORIGIN, ROTATED_CREDENTIAL),
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toBe("Plex credential cell does not support rotation");
    expect(cell.rotatable).toBe(false);
    expect(readPlexCredentialCell(cell, BOUND_ORIGIN)).toBe(ISSUED_CREDENTIAL);
  });

  it("refuses rotation for a foreign origin and keeps the previous credential", () => {
    const cell = createRotatingPlexCredentialCell(BOUND_ORIGIN, ISSUED_CREDENTIAL);

    const failure = captureFailure(() =>
      rotatePlexCredentialCell(cell, FOREIGN_ORIGIN, ROTATED_CREDENTIAL),
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toBe(
      "Plex credential cannot be used for a different origin",
    );
    expect(readPlexCredentialCell(cell, BOUND_ORIGIN)).toBe(ISSUED_CREDENTIAL);
  });

  it.each([
    ["", "Plex credential must not be empty"],
    ["rotated\u0000value", "Plex credential contains a control character"],
    ["rotated\u009fvalue", "Plex credential contains a control character"],
  ])("validates a replacement credential before adopting it: %j", (nextToken, message) => {
    const cell = createRotatingPlexCredentialCell(BOUND_ORIGIN, ISSUED_CREDENTIAL);

    const failure = captureFailure(() => rotatePlexCredentialCell(cell, BOUND_ORIGIN, nextToken));
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toBe(message);
    expect(readPlexCredentialCell(cell, BOUND_ORIGIN)).toBe(ISSUED_CREDENTIAL);
  });

  it.each(["", "configured\u0000value"])(
    "validates on read rather than at creation: %j",
    (token) => {
      const cell = createStaticPlexCredentialCell(BOUND_ORIGIN, token);

      const failure = captureFailure(() => readPlexCredentialCell(cell, BOUND_ORIGIN));
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as TypeError).message).toMatch(
        /^Plex credential (?:must not be empty|contains a control character)$/,
      );
    },
  );

  it("keeps credential material out of inspectable and serializable cell state", () => {
    const cell = createRotatingPlexCredentialCell(BOUND_ORIGIN, ISSUED_CREDENTIAL);
    rotatePlexCredentialCell(cell, BOUND_ORIGIN, ROTATED_CREDENTIAL);

    expect(Object.isFrozen(cell)).toBe(true);
    expect(Reflect.ownKeys(cell)).toEqual(["origin", "rotatable"]);
    expect(JSON.stringify(cell)).toBe('{"origin":"https://plex.example.com","rotatable":true}');
    for (const rendered of [JSON.stringify(cell), inspect(cell)]) {
      expect(rendered).not.toContain(ISSUED_CREDENTIAL);
      expect(rendered).not.toContain(ROTATED_CREDENTIAL);
    }
    expect(readPlexCredentialCell(cell, BOUND_ORIGIN)).toBe(ROTATED_CREDENTIAL);
  });
});
