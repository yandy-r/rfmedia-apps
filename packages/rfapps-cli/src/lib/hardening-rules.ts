/**
 * Declarative harden rule catalog.
 *
 * Each rule is a pure, synchronous detector over one resolved compose service
 * plus a pure proposer returning the compose edits which would satisfy it.
 * No daemon, filesystem, logging, or exit-code access.
 */

import { hasCapAdd, hasDevices, hasWritableBindMounts, runsAsRoot } from "./lint-context.js";
import type {
  HardenComposeService,
  HardenConfidence,
  HardenPatch,
  HardenRule,
  HardenRuleId,
} from "../types/hardening.js";

/** Harden rule plus its pure detection and proposal functions. */
type EvaluableHardenRule = HardenRule & {
  /** undefined = already satisfied for this service. Pure and synchronous. */
  detect: (
    service: HardenComposeService,
    serviceName: string,
  ) =>
    | undefined
    | {
        readonly evidence: readonly string[];
        readonly note?: string;
        readonly confidence?: HardenConfidence;
      };
  /** Only called when detect returned a value. Empty for advisory rules. */
  propose: (service: HardenComposeService) => readonly HardenPatch[];
};

const NO_NEW_PRIVILEGES_OPT = "no-new-privileges:true";
const CAP_DROP_ALL = "ALL";
const DEFAULT_RESTART = "unless-stopped";
/** Drivers whose options include max-size; any other driver rotates elsewhere. */
const ROTATION_CAPABLE_DRIVERS = new Set(["json-file", "local"]);
/** This repo's x-common-env convention; a plain double-quoted string so compose interpolates it. */
const REPO_USER = "${PUID}:${PGID}";

/** Order-preserving union so `merge-unique` patches carry the full resolved list. */
function unionSequence(
  existing: readonly string[] | undefined,
  additions: readonly string[],
): string[] {
  const result = [...(existing ?? [])];
  for (const addition of additions) {
    if (!result.includes(addition)) {
      result.push(addition);
    }
  }
  return result;
}

function hasRestartPolicy(service: HardenComposeService): boolean {
  if (service.restart !== undefined && service.restart.trim() !== "") {
    return true;
  }
  return service.deploy?.restart_policy !== undefined;
}

function hasCapDropAll(service: HardenComposeService): boolean {
  return service.cap_drop?.some((capability) => capability.toUpperCase() === CAP_DROP_ALL) === true;
}

function isPresent(value: string | number | undefined): boolean {
  return value !== undefined && String(value).trim() !== "";
}

/**
 * The harden rule catalog.
 *
 * Declaration order is load-bearing: it is the catalog print order and the
 * final tiebreaker when sorting proposals.
 */
export const HARDEN_RULES: readonly EvaluableHardenRule[] = [
  {
    id: "harden-no-new-privileges",
    category: "capabilities",
    severity: "info",
    confidence: "safe",
    title: "no-new-privileges not set",
    rationale: "A setuid binary inside the container can still escalate privileges.",
    guidance:
      'Add `security_opt: ["no-new-privileges:true"]` unless the service requires privilege escalation.',
    detects: { lint: "no-new-privileges-missing" },
    detect: (service) =>
      service.security_opt?.includes(NO_NEW_PRIVILEGES_OPT) === true
        ? undefined
        : { evidence: [`security_opt does not include ${NO_NEW_PRIVILEGES_OPT}`] },
    propose: (service) => [
      {
        key: "security_opt",
        operation: "merge-unique",
        value: unionSequence(service.security_opt, [NO_NEW_PRIVILEGES_OPT]),
        description: `security_opt += ["${NO_NEW_PRIVILEGES_OPT}"]`,
      },
    ],
  },
  {
    id: "harden-restart-policy",
    category: "availability",
    severity: "warn",
    confidence: "safe",
    title: "Restart policy missing",
    rationale:
      "Without a restart policy the container stays stopped after host reboot or unexpected exit.",
    guidance:
      "Set top-level `restart: unless-stopped` or `deploy.restart_policy` so the service recovers automatically.",
    detects: { lint: "restart-policy-missing" },
    detect: (service) =>
      hasRestartPolicy(service)
        ? undefined
        : { evidence: ["restart and deploy.restart_policy are both absent"] },
    propose: () => [
      {
        key: "restart",
        operation: "set",
        value: DEFAULT_RESTART,
        description: `restart = "${DEFAULT_RESTART}"`,
      },
    ],
  },
  {
    id: "harden-log-rotation",
    category: "logging",
    severity: "warn",
    confidence: "safe",
    title: "Log rotation not configured",
    rationale: "Unbounded container logs fill disk and take down every service on the host.",
    guidance:
      "Configure `logging.options.max-size` (and typically `max-file`) on a rotation-capable driver.",
    detects: { lint: "log-rotation-missing" },
    detect: (service) => {
      if (isPresent(service.logging?.options?.["max-size"])) {
        return undefined;
      }
      const evidence = ["logging.options.max-size is absent or empty"];
      const driver = service.logging?.driver;
      // max-size is a json-file/local option. On any other driver the rotation
      // patch cannot be written without changing where logs go.
      if (driver !== undefined && !ROTATION_CAPABLE_DRIVERS.has(driver)) {
        return {
          evidence,
          note: `logging.driver is "${driver}", which has no max-size option; configure rotation at the driver instead`,
          confidence: "advisory",
        };
      }
      return { evidence };
    },
    // Rebuilt from the resolved block: `set` replaces the whole logging map, so
    // any driver or option not carried here would be silently dropped.
    propose: (service) => {
      const existingDriver = service.logging?.driver;
      if (existingDriver !== undefined && !ROTATION_CAPABLE_DRIVERS.has(existingDriver)) {
        return []; // advisory: only the operator knows how this driver rotates.
      }
      const options: Record<string, string> = {
        ...(service.logging?.options ?? {}),
        "max-size": "10m",
      };
      options["max-file"] ??= "3";
      const driver = existingDriver ?? "json-file";
      const rendered = Object.entries(options)
        .map(([key, value]) => `${key}: "${value}"`)
        .join(", ");
      return [
        {
          key: "logging",
          operation: "set",
          value: { driver, options },
          description: `logging = { driver: "${driver}", options: { ${rendered} } }`,
        },
      ];
    },
  },
  {
    id: "harden-cap-drop-all",
    category: "capabilities",
    severity: "info",
    confidence: "review",
    title: "Capability drop not configured",
    rationale:
      "Dropping every capability and re-adding only what is used minimises post-compromise capability.",
    guidance:
      'Set `cap_drop: ["ALL"]` and re-add only the capabilities the workload uses with `cap_add`.',
    detects: { lint: "cap-drop-missing", audit: "cap-drop-missing" },
    detect: (service) => {
      if (hasCapDropAll(service)) {
        return undefined;
      }
      const notes: string[] = [];
      if (hasCapAdd(service)) {
        notes.push("service uses cap_add; tune cap_drop and cap_add together");
      }
      if (hasDevices(service)) {
        notes.push("device mounts present; verify required capabilities before dropping ALL");
      }
      return {
        evidence: [
          service.cap_drop === undefined || service.cap_drop.length === 0
            ? "cap_drop is absent"
            : `cap_drop=${service.cap_drop.join(",")}`,
        ],
        ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
      };
    },
    propose: (service) => [
      {
        key: "cap_drop",
        operation: "merge-unique",
        value: unionSequence(service.cap_drop, [CAP_DROP_ALL]),
        description: 'cap_drop += ["ALL"]',
      },
    ],
  },
  {
    id: "harden-read-only-rootfs",
    category: "filesystem",
    severity: "info",
    confidence: "review",
    title: "Read-only root filesystem not enabled",
    rationale:
      "A writable root filesystem lets a compromised process persist changes inside the container.",
    guidance: "Set `read_only: true` after moving every writable path to a tmpfs or volume mount.",
    detects: { lint: "read-only-rootfs" },
    detect: (service) =>
      service.read_only === true
        ? undefined
        : {
            evidence: ["read_only is not true"],
            ...(hasWritableBindMounts(service)
              ? {
                  note: "writable bind mounts detected; provide tmpfs or volume mounts for every writable path first",
                }
              : {}),
          },
    propose: () => [
      { key: "read_only", operation: "set", value: true, description: "read_only = true" },
    ],
  },
  {
    id: "harden-run-as-non-root",
    category: "identity",
    severity: "warn",
    confidence: "review",
    title: "Root-equivalent container user",
    rationale:
      "A root process shares uid 0 with the host, so a container escape or a writable bind mount becomes host-level compromise.",
    guidance:
      "Set `user` to a non-root UID:GID that owns the mounted host paths (this deployment uses ${PUID}:${PGID}).",
    detects: { audit: "root-user" },
    detect: (service) =>
      runsAsRoot(service)
        ? {
            evidence: [
              service.user === undefined || service.user.trim() === ""
                ? "user is absent (container defaults to root)"
                : `user=${service.user}`,
            ],
          }
        : undefined,
    propose: () => [
      { key: "user", operation: "set", value: REPO_USER, description: 'user = "${PUID}:${PGID}"' },
    ],
  },
  {
    id: "harden-healthcheck",
    category: "health",
    severity: "warn",
    confidence: "advisory",
    title: "Health check missing",
    rationale:
      "Without a health check, orchestrators cannot detect or replace an unhealthy container.",
    guidance:
      "Add a `healthcheck` block with a service-specific `test`, `interval`, `timeout`, `retries`, and `start_period`. rfapps will not invent a probe command; a wrong probe marks a healthy service unhealthy.",
    detects: { lint: "healthcheck-missing" },
    detect: (service) =>
      service.healthcheck !== undefined && service.healthcheck !== null
        ? undefined
        : { evidence: ["healthcheck absent"] },
    propose: () => [],
  },
  {
    id: "harden-memory-limit",
    category: "limits",
    severity: "info",
    confidence: "advisory",
    title: "Memory limit missing",
    rationale: "Without a ceiling one runaway service can OOM the whole host.",
    guidance:
      "Set `deploy.resources.limits.memory` explicitly. Ceilings are host- and workload-specific and rfapps will not guess one.",
    detects: { lint: "resource-limits-missing", audit: "memory-limit-missing" },
    detect: (service) =>
      isPresent(service.deploy?.resources?.limits?.memory)
        ? undefined
        : { evidence: ["deploy.resources.limits.memory is absent or empty"] },
    propose: () => [],
  },
  {
    id: "harden-cpu-limit",
    category: "limits",
    severity: "info",
    confidence: "advisory",
    title: "CPU limit missing",
    rationale: "An unbounded service can starve every other container on the host.",
    guidance:
      "Set `deploy.resources.limits.cpus` explicitly. Ceilings are host- and workload-specific and rfapps will not guess one.",
    detects: { audit: "cpu-limit-missing" },
    detect: (service) =>
      isPresent(service.deploy?.resources?.limits?.cpus)
        ? undefined
        : { evidence: ["deploy.resources.limits.cpus is absent or empty"] },
    propose: () => [],
  },
];

/** Rule ids in declaration order. Consumed by --rule parsing and shell completion. */
export const HARDEN_RULE_IDS: readonly HardenRuleId[] = HARDEN_RULES.map((rule) => rule.id);
