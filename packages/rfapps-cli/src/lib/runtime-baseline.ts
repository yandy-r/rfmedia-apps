/**
 * Runtime baseline observation engine for rfapps CLI.
 *
 * This is the single definition of "observe a container and turn it into a
 * state row". Both `actions/import.ts` (adopting one untracked service) and
 * `actions/state-rebuild.ts` (reconstructing the whole state database) go
 * through it, so the rows they persist are byte-identical by construction —
 * an action must never import another action.
 *
 * Key functions:
 * - {@link buildConfigSnapshotFromInspect} - Observed container config, secrets masked
 * - {@link captureRuntimeBaseline} - Image identity + config snapshot for one container
 * - {@link toBaselineEntry} - Baseline to a `deployments` row input
 *
 * Contract:
 * - Fail-closed: {@link captureRuntimeBaseline} returns `undefined` on any
 *   inspection failure, so the caller writes ZERO rows for that service and it
 *   stays reconstructible on a later run.
 * - Secret-safe: {@link maskSensitiveEnvVars} runs before persistence.
 */

import { logDebug } from "@rfmedia/common";

import { maskSensitiveEnvVars } from "./state-storage.js";
import { parseEnvArray, parsePortBindings } from "./drift.js";
import {
  inspectContainers,
  inspectContainerIdentity,
  type ContainerInspect,
  type DockerContainerIdentity,
} from "./docker.js";
import type { ConfigSnapshot, StateEntryInput } from "../types/state.js";
import type { EnvToolExecConfig } from "../types/options.js";

/** Identity + config captured from an observed container for a baseline write. */
export interface RuntimeBaseline {
  readonly identity: DockerContainerIdentity;
  readonly snapshot: ConfigSnapshot;
}

/**
 * Builds a config snapshot from a container's `docker inspect` result.
 *
 * Captures observed reality — the true rollback baseline — with secret-looking
 * environment values masked before persistence.
 */
export function buildConfigSnapshotFromInspect(inspect: ContainerInspect): ConfigSnapshot {
  const ports = parsePortBindings(inspect.HostConfig.PortBindings).map(
    (port) => `${port.host ?? ""}:${port.container}/${port.protocol}`,
  );
  return {
    image: inspect.Config.Image,
    environment: maskSensitiveEnvVars(parseEnvArray(inspect.Config.Env)),
    volumes: inspect.HostConfig.Binds ?? [],
    ports,
    networks: Object.keys(inspect.NetworkSettings.Networks ?? {}),
    labels: inspect.Config.Labels ?? {},
  };
}

/**
 * Captures image identity + config snapshot for one observed container.
 *
 * Fails closed: any inspection failure returns undefined so the caller can mark
 * the service uninspectable and write ZERO rows for it (preserving idempotency).
 */
export async function captureRuntimeBaseline(
  container: string,
  options: { readonly cwd: string; readonly envTool: EnvToolExecConfig | undefined },
): Promise<RuntimeBaseline | undefined> {
  try {
    const identity = await inspectContainerIdentity(container, {
      cwd: options.cwd,
      envTool: options.envTool,
    });
    const inspected = await inspectContainers([container], {
      cwd: options.cwd,
      envTool: options.envTool,
    });
    const inspect = inspected?.[0];
    if (inspect === undefined) {
      return undefined;
    }
    return { identity, snapshot: buildConfigSnapshotFromInspect(inspect) };
  } catch (error) {
    logDebug(
      `Failed to inspect container "${container}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * Converts a captured baseline into a deployment row input.
 *
 * The action value is the literal `"import"` for every caller: the row means
 * the same thing regardless of which command observed it (a baseline captured
 * from a container). Provenance for a rebuild lives in its result envelope and
 * the timestamped backup filename, not in the action vocabulary.
 */
export function toBaselineEntry(
  service: string,
  baseline: RuntimeBaseline,
  timestamp: string,
): StateEntryInput {
  return {
    timestamp,
    service,
    action: "import",
    imageTag: baseline.identity.configuredImage,
    imageId: baseline.identity.localImageId,
    imageDigest: baseline.identity.repositoryDigest,
    configSnapshot: JSON.stringify(baseline.snapshot),
    status: "success",
  };
}
