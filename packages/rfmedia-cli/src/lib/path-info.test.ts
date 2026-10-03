/**
 * Tests for path-info utility functions.
 */

import { describe, it, expect } from "vitest";
import { extractPathInfo } from "../lib/path-info.js";

describe("extractPathInfo", () => {
  describe("Artist folder structure (isLibraryRoot=false)", () => {
    it("should extract album name from Album/track.ext structure", () => {
      const result = extractPathInfo(
        "/source/Artist/My Album/track.mp3",
        "/source/Artist",
        "Artist Name",
        false,
      );
      expect(result).toEqual({
        artistName: "Artist Name",
        albumName: "My Album",
      });
    });

    it("should handle album with subdirectories", () => {
      const result = extractPathInfo(
        "/source/Artist/Album/Disc 1/track.mp3",
        "/source/Artist",
        "Artist Name",
        false,
      );
      expect(result).toEqual({
        artistName: "Artist Name",
        albumName: "Album",
      });
    });

    it("should handle track directly in source folder", () => {
      const result = extractPathInfo(
        "/source/Artist/track.mp3",
        "/source/Artist",
        "Artist Name",
        false,
      );
      expect(result).toEqual({
        artistName: "Artist Name",
        albumName: "Unknown Album",
      });
    });
  });

  describe("Library root structure (isLibraryRoot=true)", () => {
    it("should extract artist and album from Artist/Album/track.ext structure", () => {
      const result = extractPathInfo(
        "/source/Madonna/Confessions/track.mp3",
        "/source",
        "Fallback Artist",
        true,
      );
      expect(result).toEqual({
        artistName: "Madonna",
        albumName: "Confessions",
      });
    });

    it("should handle library root with subdirectories", () => {
      const result = extractPathInfo(
        "/source/Taylor Swift/1989/Deluxe/track.mp3",
        "/source",
        "Fallback Artist",
        true,
      );
      expect(result).toEqual({
        artistName: "Taylor Swift",
        albumName: "1989",
      });
    });

    it("should handle track directly in artist folder", () => {
      const result = extractPathInfo(
        "/source/Artist/track.mp3",
        "/source",
        "Fallback Artist",
        true,
      );
      expect(result).toEqual({
        artistName: "Artist",
        albumName: "Unknown Album",
      });
    });

    it("should handle track directly in source root", () => {
      const result = extractPathInfo("/source/track.mp3", "/source", "Fallback Artist", true);
      expect(result).toEqual({
        artistName: "Unknown Artist",
        albumName: "Unknown Album",
      });
    });
  });

  describe("Edge cases", () => {
    it("should handle paths with special characters", () => {
      const result = extractPathInfo(
        "/source/Artist/Album (Deluxe Edition)/01 - Track.mp3",
        "/source/Artist",
        "Artist Name",
        false,
      );
      expect(result).toEqual({
        artistName: "Artist Name",
        albumName: "Album (Deluxe Edition)",
      });
    });
  });
});
