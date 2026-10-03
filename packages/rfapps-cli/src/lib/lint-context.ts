/**
 * Context-aware enrichment for lint findings.
 *
 * Classifies findings into advisory groups and builds optional workload context
 * notes from compose signals. Does not change rule predicates or suppress findings.
 */

import type {
  LintComposeService,
  LintComposeVolumeMount,
  LintFindingGroup,
  LintRule,
  LintRuleId,
  LintSeverity,
} from "../types/lint.js";

/** Image name patterns for database/cache workloads */
const DATA_STORE_IMAGE_PATTERN =
  /(?:^|\/)(?:postgres(?:ql)?|redis|mysql|mariadb|mongo(?:db)?|memcached|timescale|cockroach|elasticsearch|clickhouse|influxdb)/i;

/**
 * Classify a finding into an advisory group from rule severity.
 *
 * error/warn → recommended; info → review_first
 */
export function classifyFindingGroup(rule: Pick<LintRule, "severity">): LintFindingGroup {
  if (rule.severity === "info") {
    return "review_first";
  }
  return "recommended";
}

/**
 * Classify a finding group directly from severity (for runtime drift findings).
 */
export function classifyFindingGroupFromSeverity(severity: LintSeverity): LintFindingGroup {
  return classifyFindingGroup({ severity });
}

function isShortVolumeWritable(volume: string): boolean {
  const trimmed = volume.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const segments = trimmed.split(":");
  if (segments.length >= 3 && segments[segments.length - 1] === "ro") {
    return false;
  }

  return true;
}

function isLongVolumeWritable(volume: LintComposeVolumeMount): boolean {
  return volume.read_only !== true;
}

/**
 * Whether the service has at least one writable volume mount.
 */
export function hasWritableBindMounts(service: LintComposeService): boolean {
  const volumes = service.volumes;
  if (volumes === undefined || volumes.length === 0) {
    return false;
  }

  return volumes.some((volume) => {
    if (typeof volume === "string") {
      return isShortVolumeWritable(volume);
    }
    return isLongVolumeWritable(volume);
  });
}

/**
 * Whether the service adds Linux capabilities.
 */
export function hasCapAdd(service: LintComposeService): boolean {
  return service.cap_add !== undefined && service.cap_add.length > 0;
}

/**
 * Whether the service mounts host devices.
 */
export function hasDevices(service: LintComposeService): boolean {
  return service.devices !== undefined && service.devices.length > 0;
}

/**
 * Whether the service runs as root (explicit or default).
 */
export function runsAsRoot(service: LintComposeService): boolean {
  const user = service.user;
  if (user === undefined || user.trim() === "") {
    return true;
  }

  const normalized = user.trim().toLowerCase();
  if (normalized === "0" || normalized === "root" || normalized === "0:0") {
    return true;
  }

  const uid = normalized.split(":")[0];
  return uid === "0";
}

/**
 * Whether the image reference looks like a database or cache workload.
 */
export function isDataStoreImage(image: string | undefined): boolean {
  if (image === undefined || image.trim() === "") {
    return false;
  }

  const withoutDigest = image.split("@")[0] ?? image;
  const lastColon = withoutDigest.lastIndexOf(":");
  const lastSlash = withoutDigest.lastIndexOf("/");
  const imageName = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  return DATA_STORE_IMAGE_PATTERN.test(imageName);
}

const DATA_STORE_NOTE = "Database/cache image — limits/read_only are optional; size from usage.";

/**
 * Build an optional workload context note for a fired rule and service.
 */
export function buildContextNote(
  ruleId: LintRuleId,
  service: LintComposeService,
): string | undefined {
  switch (ruleId) {
    case "read-only-rootfs": {
      if (hasWritableBindMounts(service)) {
        return "Writable bind mounts detected — read_only needs explicit RW paths (tmpfs/volumes).";
      }
      if (isDataStoreImage(service.image)) {
        return DATA_STORE_NOTE;
      }
      return undefined;
    }
    case "cap-drop-missing": {
      const notes: string[] = [];
      if (hasCapAdd(service)) {
        notes.push("Service uses cap_add — tune cap_drop/cap_add together; ALL drop may break it.");
      }
      if (hasDevices(service)) {
        notes.push("Device mounts present — verify required caps before cap_drop ALL.");
      }
      return notes.length > 0 ? notes.join(" ") : undefined;
    }
    case "no-new-privileges-missing": {
      if (runsAsRoot(service)) {
        return "Runs as root — prefer non-root user plus no-new-privileges.";
      }
      return undefined;
    }
    case "resource-limits-missing": {
      if (isDataStoreImage(service.image)) {
        return DATA_STORE_NOTE;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
