import { describe, expect, it } from "vitest";

import { sequenceTracks, type SeparationTrack } from "./separation.js";

interface TestTrack extends SeparationTrack {
  id: string;
}

function track(id: string, metadata: Omit<TestTrack, "id" | "filePath"> = {}): TestTrack {
  return { id, filePath: `/music/${id}.flac`, ...metadata };
}

describe("sequenceTracks", () => {
  it("honors feasible artist and genre gaps", () => {
    const input = [
      track("a1", { artists: ["Artist A"], genres: ["Rock"] }),
      track("a2", { artists: ["artist a"], genres: ["Pop"] }),
      track("b1", { artists: ["Artist B"], genres: ["rock"] }),
      track("b2", { artists: ["Artist B"], genres: ["Jazz"] }),
      track("c1", { artists: ["Artist C"], genres: ["Folk"] }),
    ];

    const result = sequenceTracks(input, { artist: 1, genre: 1 });

    expect(result.relaxations).toEqual([]);
    for (let index = 1; index < result.tracks.length; index++) {
      const previous = result.tracks[index - 1] as TestTrack;
      const current = result.tracks[index] as TestTrack;
      expect(previous.artists?.[0]?.toLowerCase()).not.toBe(current.artists?.[0]?.toLowerCase());
      expect(previous.genres?.[0]?.toLowerCase()).not.toBe(current.genres?.[0]?.toLowerCase());
    }
  });

  it("backtracks over greedy choices before relaxing a feasible schedule", () => {
    const input = [
      track("a1", { artists: ["A"], genres: ["X"] }),
      track("a2", { artists: ["A"], genres: ["X"] }),
      track("b1", { artists: ["B"], genres: ["Y"] }),
      track("b2", { artists: ["B"], genres: ["Y"] }),
      track("b3", { artists: ["B"], genres: ["Y"] }),
    ];

    const result = sequenceTracks(input, { artist: 1, genre: 1 });

    expect(result.tracks.map(({ id }) => id)).toEqual(["b1", "a1", "b2", "a2", "b3"]);
    expect(result.relaxations).toEqual([]);
  });

  it("widens bounded backtracking when a four-track suffix cannot recover", () => {
    const artists = ["C", "B", "C", "D", "D", "D", "B"];
    const input = artists.map((artist, index) =>
      track(`${String(index + 1).padStart(2, "0")}-${artist}`, { artists: [artist] }),
    );

    const result = sequenceTracks(input, { artist: 2 });

    expect(result.relaxations).toEqual([]);
    const lastPosition = new Map<string, number>();
    result.tracks.forEach((candidate, position) => {
      const artist = candidate.artists?.[0] as string;
      const previousPosition = lastPosition.get(artist);
      if (previousPosition !== undefined) {
        expect(position - previousPosition - 1).toBeGreaterThanOrEqual(2);
      }
      lastPosition.set(artist, position);
    });
  });

  it("relaxes an impossible gap deterministically without dropping tracks", () => {
    const input = [
      track("a1", { artists: ["Same Artist"] }),
      track("a2", { artists: ["same artist"] }),
      track("a3", { artists: ["Same Artist"] }),
    ];

    const first = sequenceTracks(input, { artist: 2 });
    const second = sequenceTracks(input, { artist: 2 });

    expect(first).toEqual(second);
    expect(first.tracks).toHaveLength(input.length);
    expect(new Set(first.tracks.map(({ id }) => id))).toEqual(new Set(["a1", "a2", "a3"]));
    expect(first.relaxations).toEqual([
      { position: 2, filePath: "/music/a2.flac", constraints: ["artist"] },
      { position: 3, filePath: "/music/a3.flac", constraints: ["artist"] },
    ]);
  });

  it("composes tempo, era, and BPM-derived energy preferences", () => {
    const input = [
      track("high-1980", { bpm: 160, year: 1985 }),
      track("low-1980", { bpm: 70, year: 1981 }),
      track("medium-1990", { bpm: 110, year: 1994 }),
    ];

    const result = sequenceTracks(input, {
      tempo: "alternate",
      era: "distribute",
      energy: "rise",
    });

    expect(result.tracks.map(({ id }) => id)).toEqual(["low-1980", "medium-1990", "high-1980"]);
  });

  it("preserves tracks with missing sequencing metadata and does not mutate input", () => {
    const input = [
      track("z-missing"),
      track("a-known", { artists: ["Artist"], genres: ["Rock"], year: 2001, bpm: 120 }),
    ];
    const snapshot = [...input];

    const result = sequenceTracks(input, {
      artist: 5,
      genre: 5,
      tempo: "alternate",
      era: "distribute",
      energy: "wave",
    });

    expect(input).toEqual(snapshot);
    expect(result.tracks.map(({ id }) => id).sort()).toEqual(["a-known", "z-missing"]);
    expect(result.relaxations).toEqual([]);
  });

  it("returns lexical path order when the policy has no active fields", () => {
    const result = sequenceTracks([track("z"), track("a"), track("m")], {});

    expect(result.tracks.map(({ id }) => id)).toEqual(["a", "m", "z"]);
    expect(result.relaxations).toEqual([]);
  });

  it("sequences a representative thousand-track personal library", () => {
    const input = Array.from({ length: 1_000 }, (_, index) =>
      track(String(index).padStart(4, "0"), {
        artists: [`Artist ${index % 100}`],
        genres: [`Genre ${index % 20}`],
        year: 1970 + (index % 50),
        bpm: 70 + (index % 100),
      }),
    );

    const result = sequenceTracks(input, {
      artist: 5,
      genre: 2,
      tempo: "alternate",
      era: "distribute",
      energy: "wave",
    });

    expect(result.tracks).toHaveLength(input.length);
    expect(new Set(result.tracks.map(({ id }) => id)).size).toBe(input.length);
    expect(result.relaxations).toEqual([]);
  });
});
