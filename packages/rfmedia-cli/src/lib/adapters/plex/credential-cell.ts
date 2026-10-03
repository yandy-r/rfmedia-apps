/**
 * The single origin-bound credential box used by every Plex token provider.
 *
 * A cell holds no credential as an enumerable property. The credential lives in
 * a module-private `WeakMap` keyed by the cell, so it is absent from reflection,
 * object spread, structured logging, `util.inspect`, and `JSON.stringify`.
 *
 * Both the static provider and the rotating JWT provider terminate in
 * {@link readPlexCredentialCell}, so #119's SEC-001 origin guard has exactly one
 * door. Rotation replaces the whole binding record; it never mutates one in
 * place, so a rejected replacement leaves the previous credential intact.
 */

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Origin-bound credential box.
 *
 * The credential is never a property of this object; it lives in a
 * module-private `WeakMap` keyed by the cell.
 */
export interface PlexCredentialCell {
  /** Canonical HTTP(S) origin the credential is bound to. */
  readonly origin: string;
  /** True when {@link rotatePlexCredentialCell} may replace the credential. */
  readonly rotatable: boolean;
}

/** Off-object credential record. Replaced wholesale on every rotation. */
interface PlexCellBinding {
  readonly origin: string;
  readonly token: string;
}

const cellBindings = new WeakMap<PlexCredentialCell, PlexCellBinding>();

/**
 * Rejects credentials that cannot travel safely in an HTTP header.
 *
 * Moved verbatim from `auth.ts` so that validation happens on every credential
 * read rather than once at construction. Both message literals are frozen by
 * `auth.test.ts`.
 *
 * @param token - Opaque legacy token or JWT.
 * @returns The credential byte-for-byte unchanged.
 * @throws TypeError when the credential is empty or contains a control character.
 */
function validateOpaqueCredential(token: string): string {
  if (token.length === 0) {
    throw new TypeError("Plex credential must not be empty");
  }
  if (CONTROL_CHARACTER_PATTERN.test(token)) {
    throw new TypeError("Plex credential contains a control character");
  }
  return token;
}

function createCell(origin: string, token: string, rotatable: boolean): PlexCredentialCell {
  const cell: PlexCredentialCell = Object.freeze({ origin, rotatable });
  cellBindings.set(cell, Object.freeze({ origin, token }));
  return cell;
}

function requireBinding(cell: PlexCredentialCell): PlexCellBinding {
  const binding = cellBindings.get(cell);
  if (binding === undefined) {
    throw new TypeError("Plex credential cell is unavailable");
  }
  return binding;
}

function assertBoundOrigin(
  cell: PlexCredentialCell,
  binding: PlexCellBinding,
  requestOrigin: string,
): void {
  if (requestOrigin !== cell.origin || requestOrigin !== binding.origin) {
    throw new TypeError("Plex credential cannot be used for a different origin");
  }
}

/**
 * Creates an immutable cell for a caller-supplied legacy token or JWT.
 *
 * The credential is deliberately not validated here; see
 * {@link readPlexCredentialCell}.
 *
 * @param origin - Canonical HTTP(S) origin the credential belongs to.
 * @param token - Opaque legacy token or pre-issued JWT.
 * @returns A frozen cell that refuses rotation.
 */
export function createStaticPlexCredentialCell(origin: string, token: string): PlexCredentialCell {
  return createCell(origin, token, false);
}

/**
 * Creates a cell whose credential may be replaced by
 * {@link rotatePlexCredentialCell}.
 *
 * Used for enrolled installs, where the JWT provider swaps in a refreshed
 * credential without rebuilding the connection.
 *
 * @param origin - Canonical HTTP(S) origin the credential belongs to.
 * @param token - Currently issued JWT.
 * @returns A frozen cell that accepts rotation for its bound origin.
 */
export function createRotatingPlexCredentialCell(
  origin: string,
  token: string,
): PlexCredentialCell {
  return createCell(origin, token, true);
}

/**
 * Reads the credential only for its bound origin, validating it on every read.
 *
 * Validation happens on READ, not at cell creation, so an empty or
 * control-character credential is rejected at `getToken()` time.
 *
 * @param cell - Origin-bound credential box.
 * @param requestOrigin - Canonical origin of the pending request.
 * @returns The unchanged opaque credential.
 * @throws TypeError when `requestOrigin` differs from the bound origin, when the
 *   cell has no binding, or when the credential is empty or contains a control
 *   character.
 */
export function readPlexCredentialCell(cell: PlexCredentialCell, requestOrigin: string): string {
  const binding = requireBinding(cell);
  assertBoundOrigin(cell, binding, requestOrigin);
  return validateOpaqueCredential(binding.token);
}

/**
 * Replaces a rotating cell's credential for its bound origin.
 *
 * The replacement is validated before the binding is swapped, so a rejected
 * credential leaves the previously issued one readable.
 *
 * @param cell - Rotating credential box created by
 *   {@link createRotatingPlexCredentialCell}.
 * @param requestOrigin - Canonical origin the refreshed credential was issued for.
 * @param nextToken - Newly issued opaque credential.
 * @throws TypeError for a static cell, a foreign origin, a cell with no binding,
 *   or an empty or control-character replacement credential.
 */
export function rotatePlexCredentialCell(
  cell: PlexCredentialCell,
  requestOrigin: string,
  nextToken: string,
): void {
  if (!cell.rotatable) {
    throw new TypeError("Plex credential cell does not support rotation");
  }
  const binding = requireBinding(cell);
  assertBoundOrigin(cell, binding, requestOrigin);
  cellBindings.set(
    cell,
    Object.freeze({ origin: binding.origin, token: validateOpaqueCredential(nextToken) }),
  );
}
