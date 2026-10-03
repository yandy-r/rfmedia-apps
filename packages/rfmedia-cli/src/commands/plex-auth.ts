/**
 * `rfmedia plex auth …` command surface (issue #251).
 *
 * A separate module from `commands/plex.ts` on purpose: that file is already
 * over the repository's size cap, and this group has its own output contract.
 *
 * NO SECRET-VALUED FLAG EXISTS HERE. There is no `--plex-token`, `--plex-jwt`,
 * `--plex-pin`, or `--plex-refresh-token`. Every flag is a REFERENCE — a URL, a
 * label, a number of seconds — never a value. `--plex-token` leaking through
 * `ps` and shell history is a known existing exposure; repeating it with
 * private-key-backed material would be strictly worse.
 *
 * NO `argParser` ANYWHERE. Commander routes an `InvalidArgumentError` thrown
 * from a parser through `Command.error()` → `process.exit(1)` *before*
 * `.action()` runs, which bypasses the failure envelope, the redaction pass,
 * and every test. So `--timeout abc` and `--plex-url ""` are handed to the
 * action as raw strings and fail there, through {@link reportFailure}.
 *
 * OUTPUT BOUNDARY. The action returns a typed success envelope or throws; this
 * layer decides how it is rendered and owns the exit code. Machine formats go
 * to stdout via `formatOutput`; text mode is rendered here, on stderr, so that
 * stdout stays parseable in every mode.
 *
 * ARCHITECTURE GATE. This file is NOT on `PLEX_COMPATIBILITY_ALLOWLIST` and
 * must not be added to it: importing `../types/plex.js` raises
 * `plex-compatibility-import` and importing `../lib/adapters/plex/*` raises
 * `private-plex-import`. Both fail `check:architecture`, which gates `typecheck`
 * and `build`. Every Plex symbol reachable from here arrives through the action
 * layer, which in turn imports only the `plex-adapter.js` façade.
 */

import { Command } from "commander";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { logError, logInfo, logSuccess, logWarn } from "../lib/logger.js";
import type {
  PlexAuthLoginEnvelope,
  PlexAuthLogoutEnvelope,
  PlexAuthRefreshEnvelope,
  PlexAuthStatusEnvelope,
  PlexAuthVerb,
} from "../actions/plex-auth.js";
import type { GlobalOptions } from "../types/options.js";

const MILLISECONDS_PER_SECOND = 1000;

/**
 * The one unverified wire assumption, stated where an operator will hit it.
 *
 * Nothing in this build has observed the JWT token endpoint's success body
 * against a live Plex account, so a shape change surfaces as
 * `PLEX_AUTH_INVALID_RESPONSE` rather than as a wrong credential.
 */
const LOGIN_PROVISIONAL_NOTICE =
  "\nThe JWT token endpoint's success response has not been observed against a live account; report `PLEX_AUTH_INVALID_RESPONSE` with `--debug` if enrollment fails.";

/**
 * Plex account authorization command group.
 *
 * Registered beneath `plex` by `commands/plex.ts`; the root program is reached
 * through Commander's parent chain, so no import cycle is created.
 */
export const plexAuthCommand = new Command("auth").description("Manage Plex account authorization");

/**
 * Reads the global options object from whichever command owns the process.
 *
 * Walks to the root rather than assuming a fixed depth, so the group behaves
 * identically when mounted under `plex` in production and under a test harness.
 *
 * @returns The root command's parsed options, or `undefined` when unmounted.
 */
function resolveGlobalOptions(): GlobalOptions | undefined {
  let current: Command | null = plexAuthCommand.parent;
  if (current === null) return undefined;
  while (current.parent !== null) {
    current = current.parent;
  }
  return current.opts() as GlobalOptions | undefined;
}

/**
 * Resolves the active output format.
 *
 * `--output` is reconciled against `--json` by `cli.ts`'s `preAction` hook. Both
 * are declared on the ROOT command, but the CLI never enables Commander's
 * positional-options mode, so a root option binds to the root in either
 * position: `rfmedia --output json plex auth status` and
 * `rfmedia plex auth status --output json` are equivalent. No verb in this group
 * declares its own `-o/--output`, so nothing shadows the root flag.
 *
 * @returns The reconciled format, defaulting to human-readable text.
 */
function resolveOutputFormat(): OutputFormat {
  return resolveGlobalOptions()?.output ?? "text";
}

/**
 * Whether the operator asked for diagnostic detail.
 *
 * Gates `observedKeys` in text mode; the field is always present in machine
 * output, where a consumer can ignore it.
 *
 * @returns True when `--debug` is set on the root command.
 */
function isDebugEnabled(): boolean {
  return resolveGlobalOptions()?.debug === true;
}

/**
 * Renders an epoch-second timestamp for a human.
 *
 * @param epochSeconds - Seconds since the Unix epoch.
 * @returns An ISO-8601 timestamp.
 */
function formatEpochSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * MILLISECONDS_PER_SECOND).toISOString();
}

/**
 * Emits a verb's success envelope in whichever format the operator asked for.
 *
 * @param format - The reconciled output format.
 * @param envelope - The action's `{ command, result }` envelope.
 * @param renderText - Human rendering, used only for text and table formats.
 */
async function emitSuccess(
  format: OutputFormat,
  envelope: unknown,
  renderText: () => void,
): Promise<void> {
  if (isMachineFormat(format)) {
    const { formatOutput } = await import("../lib/formatters/index.js");
    await formatOutput(format, envelope);
    return;
  }
  renderText();
}

/**
 * Projects a caught value onto the shared failure envelope and exits non-zero.
 *
 * The envelope is built by the action layer, which owns redaction and the code
 * taxonomy; this function only chooses a rendering and sets the exit code. In
 * text mode the remediation is printed explicitly, because `formatOutput`
 * deliberately writes nothing for human formats.
 *
 * @param format - The reconciled output format.
 * @param verb - Which `plex auth` verb failed.
 * @param error - The value it threw.
 */
async function reportFailure(
  format: OutputFormat,
  verb: PlexAuthVerb,
  error: unknown,
): Promise<void> {
  const { buildPlexAuthFailureEnvelope } = await import("../actions/plex-auth.js");
  const envelope = buildPlexAuthFailureEnvelope(verb, error);

  if (isMachineFormat(format)) {
    const { formatOutput } = await import("../lib/formatters/index.js");
    await formatOutput(format, envelope);
  } else {
    logError(`${envelope.error.message} [${envelope.error.code}]`);
    logInfo(envelope.error.remediation);
    if (envelope.error.retryAfterSeconds !== null) {
      logInfo(`Retry after ${envelope.error.retryAfterSeconds}s.`);
    }
    if (isDebugEnabled() && envelope.error.diagnostics !== undefined) {
      logInfo(`Observed response keys: ${envelope.error.diagnostics.observedKeys.join(", ")}`);
    }
  }

  process.exitCode = 1;
}

/**
 * Renders a completed enrollment.
 *
 * @param result - The `plex-auth-login` result; no field is a secret.
 */
function renderLogin(result: PlexAuthLoginEnvelope["result"]): void {
  logSuccess(`Enrolled with Plex for ${result.origin}`);
  logInfo(`Device "${result.deviceName}" · kid ${result.kid} · client ${result.clientIdentifier}`);
  logInfo(
    `Credential expires ${formatEpochSeconds(result.expiresAtEpochSeconds)}${
      result.lifetimeAssumed ? " (assumed lifetime)" : ""
    }`,
  );
  if (result.replacedExistingEnrollment) {
    logWarn("A previous enrollment was replaced; its credential no longer works.");
  }
}

/**
 * Renders the offline store projection.
 *
 * @param result - The `plex-auth-status` result; no field is a secret.
 */
function renderStatus(result: PlexAuthStatusEnvelope["result"]): void {
  if (!result.enrolled) {
    logWarn(`Not enrolled. No credential store at ${result.storePath}.`);
    logInfo("Run `rfmedia plex auth login` to enroll this device.");
    return;
  }

  logSuccess(`Enrolled as "${result.deviceName}" · kid ${result.kid}`);
  logInfo(
    `Store ${result.storePath} (mode ${result.storeMode}${
      result.storeOwnerOnly ? ", owner-only" : ", NOT owner-only"
    })`,
  );
  // Named verbatim by PLEX_AUTH_REFRESH_BUSY's remediation, so an operator
  // debugging a stuck refresh finds it here without switching output formats.
  logInfo(`Lock ${result.lockPath}`);
  logInfo(
    `Credential ${result.credential.state}, ${result.credential.secondsRemaining}s remaining${
      result.credential.lifetimeAssumed ? " (assumed lifetime)" : ""
    }`,
  );
  if (result.clockSkewSeconds !== null) {
    logInfo(`Last observed clock skew ${result.clockSkewSeconds}s.`);
  }
  if (result.origin !== null) {
    logInfo(
      result.originAuthorized === true
        ? `${result.origin} is authorized.`
        : `${result.origin} is NOT authorized by this enrollment.`,
    );
  }
  for (const origin of result.origins) {
    logInfo(`  ${origin.origin} · server ${origin.machineIdentifier}`);
  }
}

/**
 * Renders a rotation attempt.
 *
 * @param result - The `plex-auth-refresh` result; no field is a secret.
 */
function renderRefresh(result: PlexAuthRefreshEnvelope["result"]): void {
  if (result.refreshed) {
    logSuccess(`Credential rotated (${result.reason}).`);
  } else {
    logInfo(`No rotation performed (${result.reason}).`);
  }
  logInfo(
    `Credential expires ${formatEpochSeconds(result.expiresAtEpochSeconds)}${
      result.lifetimeAssumed ? " (assumed lifetime)" : ""
    }`,
  );
  if (!result.singleFlightLeader) {
    logInfo("Adopted a credential rotated by a concurrent rfmedia process.");
  }
  // `retryAfterSeconds` is never populated on a SUCCESS result: an open
  // cooperative back-off window is re-thrown as `PLEX_AUTH_RATE_LIMITED` and the
  // wait is rendered by {@link reportFailure}. Nothing is printed for it here.
}

/**
 * Renders the destruction of the local root of authority.
 *
 * @param result - The `plex-auth-logout` result.
 */
function renderLogout(result: PlexAuthLogoutEnvelope["result"]): void {
  logSuccess(
    result.keyDestroyed
      ? "Local Plex credential and signing key destroyed."
      : "No local Plex enrollment material was present.",
  );
  if (result.removedOrigins.length > 0) {
    logInfo(`Removed authorization for ${result.removedOrigins.join(", ")}`);
  }
  logWarn(
    `Server-side revocation is ${result.serverSideRevocation}: remove the device at ${result.authorizedDevicesUrl}`,
  );
}

/**
 * `plex auth login` — enroll this device with a Plex account.
 *
 * Works headlessly: the authorization link goes to stderr and the poll needs no
 * terminal. `--yes` is only consulted when an enrollment already exists, since
 * replacing one mints a new signing key and invalidates the old credential.
 */
const plexAuthLoginCommand = new Command("login")
  .description("Enroll this device with your Plex account")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--device-name <name>", "Device label shown in your Plex account")
  .option("--timeout <seconds>", "Authorization timeout in seconds")
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText("after", LOGIN_PROVISIONAL_NOTICE)
  .action(async (cmdOptions: Record<string, unknown>) => {
    const format = resolveOutputFormat();
    try {
      const { executePlexAuthLogin } = await import("../actions/plex-auth.js");
      const envelope = await executePlexAuthLogin({
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        deviceName: cmdOptions["deviceName"] as string | undefined,
        timeout: cmdOptions["timeout"] as string | undefined,
        yes: cmdOptions["yes"] as boolean | undefined,
        format,
      });
      await emitSuccess(format, envelope, () => {
        renderLogin(envelope.result);
      });
    } catch (error) {
      await reportFailure(format, "login", error);
    }
  });

/**
 * `plex auth status` — report enrollment and credential state.
 *
 * Makes no network call, so it stays usable while plex.tv is unreachable or
 * rate limiting this address.
 */
const plexAuthStatusCommand = new Command("status")
  .description("Show enrollment and credential status")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .action(async (cmdOptions: Record<string, unknown>) => {
    const format = resolveOutputFormat();
    try {
      const { executePlexAuthStatus } = await import("../actions/plex-auth.js");
      const envelope = executePlexAuthStatus({
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        format,
      });
      await emitSuccess(format, envelope, () => {
        renderStatus(envelope.result);
      });
    } catch (error) {
      await reportFailure(format, "status", error);
    }
  });

/**
 * `plex auth refresh` — rotate the stored credential, single-flight.
 *
 * `--force` overrides the local freshness gate only; a server-imposed
 * rate-limit window still fails with `PLEX_AUTH_RATE_LIMITED` and exit code 1.
 */
const plexAuthRefreshCommand = new Command("refresh")
  .description("Rotate the stored credential")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--timeout <seconds>", "Authorization timeout in seconds")
  .option(
    "--force",
    "Rotate now even if the credential is fresh (does not bypass Plex rate limits)",
  )
  .action(async (cmdOptions: Record<string, unknown>) => {
    const format = resolveOutputFormat();
    try {
      const { executePlexAuthRefresh } = await import("../actions/plex-auth.js");
      const envelope = await executePlexAuthRefresh({
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        timeout: cmdOptions["timeout"] as string | undefined,
        force: cmdOptions["force"] as boolean | undefined,
        format,
      });
      await emitSuccess(format, envelope, () => {
        renderRefresh(envelope.result);
      });
    } catch (error) {
      await reportFailure(format, "refresh", error);
    }
  });

/**
 * `plex auth logout` — destroy the local enrollment material.
 *
 * One signing key backs every authorized origin, so this is never scoped by
 * `--plex-url`; the result reports which origins the removal covered.
 */
const plexAuthLogoutCommand = new Command("logout")
  .description("Remove local enrollment material")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (cmdOptions: Record<string, unknown>) => {
    const format = resolveOutputFormat();
    try {
      const { executePlexAuthLogout } = await import("../actions/plex-auth.js");
      const envelope = await executePlexAuthLogout({
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        yes: cmdOptions["yes"] as boolean | undefined,
        format,
      });
      await emitSuccess(format, envelope, () => {
        renderLogout(envelope.result);
      });
    } catch (error) {
      await reportFailure(format, "logout", error);
    }
  });

plexAuthCommand.addCommand(plexAuthLoginCommand);
plexAuthCommand.addCommand(plexAuthStatusCommand);
plexAuthCommand.addCommand(plexAuthRefreshCommand);
plexAuthCommand.addCommand(plexAuthLogoutCommand);
