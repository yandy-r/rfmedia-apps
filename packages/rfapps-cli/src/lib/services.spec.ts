import { describe, expect, it } from "vitest";

import type { RfappsConfig } from "../types/index.js";
import {
  autoDetectProfiles,
  expandServiceGroup,
  expandServicesWithSidecars,
  getAvailableGroups,
  getMainServicesForSidecar,
  getProfileForService,
  getSidecarForService,
  isSidecar,
  isValidProfile,
} from "./services.js";

const config = {
  sidecars: {
    enabled: true,
    mapping: {
      plex: "plex-ts",
      sabnzbd: "vpn-ts",
      slskd: "vpn-ts",
    },
  },
  profiles: {
    defaultProfile: "core",
    validProfiles: ["core", "media", "downloads", "all"],
    mapping: {
      plex: "media",
      "plex-ts": "media",
      sabnzbd: "downloads",
      slskd: "downloads",
      traefik: "core",
    },
  },
  groups: {
    media: ["plex", "plex-ts"],
    downloads: ["sabnzbd", "slskd", "vpn-ts"],
  },
} as unknown as RfappsConfig;

describe("service mapping utilities", () => {
  it("looks up service sidecars and reverse sidecar mappings", () => {
    expect(getSidecarForService("plex", config)).toBe("plex-ts");
    expect(getSidecarForService("traefik", config)).toBeUndefined();
    expect(getMainServicesForSidecar("vpn-ts", config)).toEqual(["sabnzbd", "slskd"]);
    expect(getMainServicesForSidecar("plex", config)).toEqual([]);
  });

  it("identifies configured sidecars only when the service name has the sidecar suffix", () => {
    expect(isSidecar("plex-ts", config)).toBe(true);
    expect(isSidecar("vpn-ts", config)).toBe(true);
    expect(isSidecar("sabnzbd", config)).toBe(false);
    expect(isSidecar("orphan-ts", config)).toBe(false);
  });

  it("expands services bidirectionally while preserving first-seen order", () => {
    expect(expandServicesWithSidecars(["plex", "vpn-ts", "plex"], config)).toEqual([
      "plex",
      "plex-ts",
      "vpn-ts",
      "sabnzbd",
      "slskd",
    ]);
  });

  it("resolves profile and group metadata from config with documented fallbacks", () => {
    expect(getProfileForService("plex", config)).toBe("media");
    expect(getProfileForService("unknown", config)).toBe("all");
    expect(autoDetectProfiles(["plex", "traefik", "missing"], config)).toEqual([
      "media",
      "core",
      "all",
    ]);
    expect(expandServiceGroup("downloads", config)).toEqual(["sabnzbd", "slskd", "vpn-ts"]);
    expect(expandServiceGroup("missing", config)).toBeUndefined();
    expect(getAvailableGroups(config)).toEqual(["media", "downloads"]);
  });

  it("validates profile names against configured profiles", () => {
    expect(isValidProfile("media", config)).toBe(true);
    expect(isValidProfile("invalid", config)).toBe(false);
  });
});
