/**
 * Tests for plex.ts command layer - Plex playlist subcommands.
 *
 * Tests command parsing and option handling for playlist export, sync, and list commands.
 * These tests verify that commands are parsed correctly and delegate to the action layer
 * with the expected options.
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// Mock action handlers with vi.hoisted() - must be defined before vi.mock() calls
const mockActions = vi.hoisted(() => ({
  executePlaylistExport: vi.fn().mockResolvedValue({
    playlistName: "Test Playlist",
    totalTracks: 10,
    created: 10,
    skipped: 0,
    failed: [],
    totalSize: 1000000,
  }),
  executePlaylistSync: vi.fn().mockResolvedValue({
    playlistName: "Test Playlist",
    totalTracks: 10,
    created: 8,
    skipped: 0,
    removed: 2,
    failed: [],
    totalSize: 800000,
  }),
  listPlaylists: vi.fn().mockResolvedValue([
    {
      ratingKey: "1",
      title: "Playlist 1",
      smart: false,
      leafCount: 10,
      duration: 300000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    },
    {
      ratingKey: "2",
      title: "Playlist 2",
      smart: true,
      leafCount: 5,
      duration: 150000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    },
  ]),
  executePlaylistCreate: vi.fn().mockResolvedValue({
    playlistName: "Created Playlist",
    ratingKey: "playlist-3",
    tracksAdded: 7,
    action: "created",
    smart: false,
  }),
  executePlaylistAdd: vi.fn().mockResolvedValue({
    playlistName: "Test Playlist",
    ratingKey: "playlist-1",
    tracksAdded: 3,
    totalTracks: 13,
  }),
}));

const mockCopyActions = vi.hoisted(() => ({
  executePlexCopy: vi.fn().mockResolvedValue({
    created: 2,
    skipped: 1,
    failed: [],
    totalSize: 4096,
  }),
}));

const mockCollectionActions = vi.hoisted(() => ({
  executeCollectionCreate: vi.fn().mockResolvedValue({
    collection: {
      ratingKey: "100",
      title: "Test Collection",
      smart: false,
      childCount: 24,
      metadataType: 8,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    },
    itemsAdded: 24,
    totalItems: 24,
  }),
  executeCollectionAdd: vi.fn().mockResolvedValue({
    collection: {
      ratingKey: "100",
      title: "Test Collection",
      smart: false,
      childCount: 24,
      metadataType: 8,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    },
    itemsAdded: 24,
    totalItems: 24,
  }),
  executeCollectionList: vi.fn().mockResolvedValue([
    {
      ratingKey: "100",
      key: "/library/collections/100/children",
      title: "Test Collection",
      smart: false,
      childCount: 24,
      metadataType: 9,
      mediaType: "album",
      summary: "Collection summary",
      addedAt: 1700000000,
      updatedAt: 1700000100,
      type: "collection",
    },
  ]),
  executeCollectionShow: vi.fn().mockResolvedValue({
    ratingKey: "100",
    key: "/library/collections/100/children",
    title: "Test Collection",
    smart: false,
    childCount: 24,
    metadataType: 9,
    mediaType: "album",
    summary: "Collection summary",
    addedAt: 1700000000,
    updatedAt: 1700000100,
    type: "collection",
  }),
  executeCollectionDelete: vi.fn().mockResolvedValue(undefined),
}));

const mockQueryActions = vi.hoisted(() => ({
  executePlexQuery: vi.fn().mockResolvedValue({
    tracks: [
      {
        ratingKey: "track-1",
        title: "Test Track",
        artist: "Test Artist",
        album: "Test Album",
        userRating: 8,
        viewCount: 3,
        duration: 180000,
        filePath: "/music/Test Track.flac",
        moods: ["Focused"],
      },
    ],
    totalSize: 1,
    offset: 0,
    hasMore: false,
    queryId: 42,
  }),
}));

const mockSyncActions = vi.hoisted(() => ({
  executeMetadataSync: vi.fn().mockResolvedValue({
    totalTracks: 5,
    synced: 3,
    skipped: 1,
    conflicts: 1,
    failed: [],
  }),
}));

const mockDb = vi.hoisted(() => ({
  initializeDatabase: vi.fn().mockResolvedValue({}),
  listPlexQueries: vi.fn().mockReturnValue([
    {
      id: 42,
      created_at: "2026-07-20T00:00:00.000Z",
      library_name: "Music",
      media_type: "track",
      filters_json: "{}",
      result_count: 1,
      total_count: 1,
      status: "completed",
      name: "Favorites",
    },
  ]),
  closeDatabase: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  outputJson: vi.fn(),
}));

const mockFormatters = vi.hoisted(() => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));

const mockGetTerminalWidth = vi.hoisted(() => vi.fn().mockReturnValue(120));

// Apply mocks BEFORE importing the module under test
vi.mock("../actions/plex-playlist.js", () => mockActions);
vi.mock("../actions/plex-collection.js", () => mockCollectionActions);
vi.mock("../actions/plex-query.js", () => mockQueryActions);
vi.mock("../actions/plex-copy.js", () => mockCopyActions);
vi.mock("../actions/plex-sync.js", () => mockSyncActions);
vi.mock("../lib/db.js", () => mockDb);
vi.mock("../lib/logger.js", () => mockLogger);
vi.mock("../lib/formatters/index.js", () => mockFormatters);
vi.mock("../lib/terminal-table.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/terminal-table.js")>();
  return {
    ...actual,
    getTerminalWidth: mockGetTerminalWidth,
  };
});

// Import after mocks - we need to import the plexCommand
import { plexCommand } from "./plex.js";

function findCommand(parent: Command, name: string): Command {
  const command = parent.commands.find((candidate) => candidate.name() === name);
  if (!command) {
    throw new Error(`Expected command ${name} beneath ${parent.name()}`);
  }
  return command;
}

function optionFlags(command: Command): string[] {
  return command.options.map((option) => option.flags);
}

describe("plex commands", () => {
  let rootCommand: Command;

  beforeEach(() => {
    vi.clearAllMocks(); // NOT resetAllMocks!

    // Re-establish terminal width default after clearAllMocks
    mockGetTerminalWidth.mockReturnValue(120);

    // Re-establish default mock implementations after clearAllMocks
    mockActions.executePlaylistExport.mockResolvedValue({
      playlistName: "Test Playlist",
      totalTracks: 10,
      created: 10,
      skipped: 0,
      failed: [],
      totalSize: 1000000,
    });
    mockActions.executePlaylistSync.mockResolvedValue({
      playlistName: "Test Playlist",
      totalTracks: 10,
      created: 8,
      skipped: 0,
      removed: 2,
      failed: [],
      totalSize: 800000,
    });
    mockActions.listPlaylists.mockResolvedValue([
      {
        ratingKey: "1",
        title: "Playlist 1",
        smart: false,
        leafCount: 10,
        duration: 300000,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
      {
        ratingKey: "2",
        title: "Playlist 2",
        smart: true,
        leafCount: 5,
        duration: 150000,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
    ]);
    mockActions.executePlaylistCreate.mockResolvedValue({
      playlistName: "Created Playlist",
      ratingKey: "playlist-3",
      tracksAdded: 7,
      action: "created",
      smart: false,
    });
    mockActions.executePlaylistAdd.mockResolvedValue({
      playlistName: "Test Playlist",
      ratingKey: "playlist-1",
      tracksAdded: 3,
      totalTracks: 13,
    });
    mockCopyActions.executePlexCopy.mockResolvedValue({
      created: 2,
      skipped: 1,
      failed: [],
      totalSize: 4096,
    });
    mockCollectionActions.executeCollectionCreate.mockResolvedValue({
      collection: {
        ratingKey: "100",
        title: "Test Collection",
        smart: false,
        childCount: 24,
        metadataType: 8,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
      itemsAdded: 24,
      totalItems: 24,
    });
    mockCollectionActions.executeCollectionAdd.mockResolvedValue({
      collection: {
        ratingKey: "100",
        title: "Test Collection",
        smart: false,
        childCount: 24,
        metadataType: 8,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
      itemsAdded: 24,
      totalItems: 24,
    });
    mockCollectionActions.executeCollectionList.mockResolvedValue([
      {
        ratingKey: "100",
        key: "/library/collections/100/children",
        title: "Test Collection",
        smart: false,
        childCount: 24,
        metadataType: 9,
        mediaType: "album",
        summary: "Collection summary",
        addedAt: 1700000000,
        updatedAt: 1700000100,
        type: "collection",
      },
    ]);
    mockCollectionActions.executeCollectionShow.mockResolvedValue({
      ratingKey: "100",
      key: "/library/collections/100/children",
      title: "Test Collection",
      smart: false,
      childCount: 24,
      metadataType: 9,
      mediaType: "album",
      summary: "Collection summary",
      addedAt: 1700000000,
      updatedAt: 1700000100,
      type: "collection",
    });
    mockCollectionActions.executeCollectionDelete.mockResolvedValue(undefined);
    mockQueryActions.executePlexQuery.mockResolvedValue({
      tracks: [
        {
          ratingKey: "track-1",
          title: "Test Track",
          artist: "Test Artist",
          album: "Test Album",
          userRating: 8,
          viewCount: 3,
          duration: 180000,
          filePath: "/music/Test Track.flac",
          moods: ["Focused"],
        },
      ],
      totalSize: 1,
      offset: 0,
      hasMore: false,
      queryId: 42,
    });
    mockSyncActions.executeMetadataSync.mockResolvedValue({
      totalTracks: 5,
      synced: 3,
      skipped: 1,
      conflicts: 1,
      failed: [],
    });
    mockDb.initializeDatabase.mockResolvedValue({});
    mockDb.listPlexQueries.mockReturnValue([
      {
        id: 42,
        created_at: "2026-07-20T00:00:00.000Z",
        library_name: "Music",
        media_type: "track",
        filters_json: "{}",
        result_count: 1,
        total_count: 1,
        status: "completed",
        name: "Favorites",
      },
    ]);
    mockDb.closeDatabase.mockReturnValue(undefined);

    // Create a root command to attach plex command to (for global options)
    rootCommand = new Command("rfmedia");
    rootCommand.option("--json", "Output in JSON format");
    rootCommand.option("--output <format>", "Output format (json, yaml, csv, table, text)");
    rootCommand.option("--debug", "Enable debug output");

    // Create a fresh copy of plexCommand for each test to avoid state pollution
    // We need to re-add the plexCommand to the root command
    rootCommand.addCommand(plexCommand);
  });

  afterEach(() => {
    // Reset process.exitCode if set during tests
    process.exitCode = undefined;
  });

  describe("generated command contract", () => {
    it("keeps the Plex command hierarchy stable", () => {
      expect(plexCommand.commands.map((command) => command.name())).toEqual([
        "query",
        "copy",
        "playlist",
        "collection",
        "sync",
        "auth",
      ]);
      expect(findCommand(plexCommand, "query").commands.map((command) => command.name())).toEqual([
        "run",
        "list",
      ]);
      expect(findCommand(plexCommand, "copy").commands.map((command) => command.name())).toEqual([
        "query-results",
        "query",
      ]);
      expect(
        findCommand(plexCommand, "playlist").commands.map((command) => command.name()),
      ).toEqual(["export", "sync", "list", "create", "add"]);
      expect(
        findCommand(plexCommand, "collection").commands.map((command) => command.name()),
      ).toEqual(["create", "add", "list", "show", "delete"]);
      expect(findCommand(plexCommand, "sync").commands.map((command) => command.name())).toEqual([
        "push",
        "pull",
        "both",
      ]);
    });

    it("keeps query help and public connection/filter aliases stable", () => {
      const queryRun = findCommand(findCommand(plexCommand, "query"), "run");
      const help = queryRun.helpInformation();

      expect(optionFlags(queryRun)).toEqual(
        expect.arrayContaining([
          "-l, --library <name>",
          "-t, --type <type>",
          "--min-track-stars <rating>",
          "--max-track-stars <rating>",
          "--plex-url <url>",
          "--plex-token <token>",
          "-n, --name <name>",
          "--no-save",
          "-F, --filter <name>",
        ]),
      );
      expect(help).toContain("Query Plex library with filters");
      expect(help).toContain('choices: "track", "album", "artist"');
      expect(help).not.toContain("jwt");
      expect(mockQueryActions.executePlexQuery).not.toHaveBeenCalled();
      expect(mockActions.executePlaylistExport).not.toHaveBeenCalled();
      expect(mockCollectionActions.executeCollectionCreate).not.toHaveBeenCalled();
    });

    it("keeps playlist and collection options and add-mode aliases stable", () => {
      const playlistExport = findCommand(findCommand(plexCommand, "playlist"), "export");
      const collectionCreate = findCommand(findCommand(plexCommand, "collection"), "create");
      const collectionAdd = findCommand(findCommand(plexCommand, "collection"), "add");

      expect(optionFlags(playlistExport)).toEqual(
        expect.arrayContaining([
          "--hardlink",
          "--convert <format>",
          "-w, --workers <n>",
          "--dry-run",
          "--no-progress",
          "--plex-scan",
          "--preserve-structure",
          "--flat",
          "--folder <name>",
        ]),
      );
      for (const command of [collectionCreate, collectionAdd]) {
        expect(optionFlags(command)).toEqual(
          expect.arrayContaining([
            "--mode <mode>",
            "--add-track",
            "--add-album",
            "--add-artist",
            "--plex-url <url>",
            "--plex-token <token>",
          ]),
        );
      }
    });
  });

  describe("machine output compatibility", () => {
    it("keeps the plex-query discriminator and Plex result fields", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "json", "plex", "query", "run", "--library", "Music"],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "plex-query",
        result: {
          tracks: [
            {
              ratingKey: "track-1",
              title: "Test Track",
              artist: "Test Artist",
              album: "Test Album",
              userRating: 8,
              viewCount: 3,
              duration: 180000,
              filePath: "/music/Test Track.flac",
              moods: ["Focused"],
            },
          ],
          totalSize: 1,
          offset: 0,
          hasMore: false,
          queryId: 42,
        },
      });
    });

    it("keeps the plex-query-list discriminator and saved row fields", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "json", "plex", "query", "list"],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "plex-query-list",
        result: {
          queries: [
            {
              id: 42,
              created_at: "2026-07-20T00:00:00.000Z",
              library_name: "Music",
              media_type: "track",
              filters_json: "{}",
              result_count: 1,
              total_count: 1,
              status: "completed",
              name: "Favorites",
            },
          ],
          total: 1,
        },
      });
      expect(mockDb.closeDatabase).toHaveBeenCalledWith({});
    });

    it("keeps the collection-create discriminator and projected fields", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "json",
          "plex",
          "collection",
          "create",
          "Test Collection",
          "--library",
          "Music",
          "--type",
          "album",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "plex-collection-create",
        result: {
          collectionName: "Test Collection",
          totalItems: 24,
          itemsAdded: 24,
          smart: false,
          mediaType: "artist",
          metadataType: 8,
        },
      });
    });

    it("keeps plex-copy fields and suppresses progress for YAML output", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "yaml",
          "plex",
          "copy",
          "query-results",
          "/destination",
          "--query-id",
          "42",
        ],
        { from: "node" },
      );

      expect(mockCopyActions.executePlexCopy).toHaveBeenCalledWith(
        expect.objectContaining({ progress: false }),
      );
      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("yaml", {
        command: "plex-copy",
        result: { created: 2, skipped: 1, failed: 0, totalSize: 4096 },
      });
    });

    it("keeps playlist export and sync discriminators and CSV fields", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "csv",
          "plex",
          "playlist",
          "export",
          "Test Playlist",
          "/destination",
        ],
        { from: "node" },
      );

      expect(mockActions.executePlaylistExport).toHaveBeenCalledWith(
        expect.objectContaining({ progress: false }),
      );
      expect(mockFormatters.formatOutput).toHaveBeenLastCalledWith("csv", {
        command: "plex-playlist-export",
        result: {
          playlistName: "Test Playlist",
          totalTracks: 10,
          created: 10,
          skipped: 0,
          failed: 0,
          totalSize: 1000000,
        },
      });

      mockFormatters.formatOutput.mockClear();
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "csv",
          "plex",
          "playlist",
          "sync",
          "Test Playlist",
          "/destination",
        ],
        { from: "node" },
      );

      expect(mockActions.executePlaylistSync).toHaveBeenCalledWith(
        expect.objectContaining({ progress: false }),
      );
      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("csv", {
        command: "plex-playlist-sync",
        result: {
          playlistName: "Test Playlist",
          totalTracks: 10,
          created: 8,
          skipped: 0,
          removed: 2,
          failed: 0,
          totalSize: 800000,
        },
      });
    });

    it("keeps playlist create and add machine fields", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "json",
          "plex",
          "playlist",
          "create",
          "Created Playlist",
          "--library",
          "Music",
          "--genre",
          "Rock",
        ],
        { from: "node" },
      );

      expect(mockActions.executePlaylistCreate).toHaveBeenCalledWith(
        expect.objectContaining({ progress: false, json: true }),
      );
      expect(mockFormatters.formatOutput).toHaveBeenLastCalledWith("json", {
        command: "plex-playlist-create",
        result: {
          playlistName: "Created Playlist",
          ratingKey: "playlist-3",
          tracksAdded: 7,
          action: "created",
          smart: false,
        },
      });

      mockFormatters.formatOutput.mockClear();
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "json",
          "plex",
          "playlist",
          "add",
          "Test Playlist",
          "--library",
          "Music",
          "--genre",
          "Rock",
        ],
        { from: "node" },
      );

      expect(mockActions.executePlaylistAdd).toHaveBeenCalledWith(
        expect.objectContaining({ progress: false, json: true }),
      );
      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "plex-playlist-add",
        result: {
          playlistName: "Test Playlist",
          ratingKey: "playlist-1",
          tracksAdded: 3,
          totalTracks: 13,
        },
      });
    });

    it("keeps metadata sync discriminator, failed rows, progress, and exit behavior", async () => {
      mockSyncActions.executeMetadataSync.mockResolvedValue({
        totalTracks: 5,
        synced: 3,
        skipped: 1,
        conflicts: 1,
        failed: [{ path: "/music/failed.flac", message: "write failed" }],
      });

      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "yaml", "plex", "sync", "push", "/music"],
        { from: "node" },
      );

      expect(mockSyncActions.executeMetadataSync).toHaveBeenCalledWith(
        expect.objectContaining({ progress: false }),
      );
      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("yaml", {
        command: "plex-sync-push",
        result: {
          totalTracks: 5,
          synced: 3,
          skipped: 1,
          conflicts: 1,
          failedCount: 1,
          failed: [{ path: "/music/failed.flac", message: "write failed" }],
        },
      });
      expect(process.exitCode).toBe(1);
    });

    it("keeps pull and both metadata sync discriminators", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "json", "plex", "sync", "pull", "/music"],
        { from: "node" },
      );
      expect(mockFormatters.formatOutput).toHaveBeenLastCalledWith(
        "json",
        expect.objectContaining({ command: "plex-sync-pull" }),
      );

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "json",
          "plex",
          "sync",
          "both",
          "/music",
          "--prefer",
          "plex",
        ],
        { from: "node" },
      );
      expect(mockFormatters.formatOutput).toHaveBeenLastCalledWith(
        "json",
        expect.objectContaining({ command: "plex-sync-both" }),
      );
    });

    it("keeps collection add, list, show, and delete machine projections", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "json",
          "plex",
          "collection",
          "add",
          "Test Collection",
          "--library",
          "Music",
        ],
        { from: "node" },
      );
      expect(mockFormatters.formatOutput).toHaveBeenLastCalledWith("json", {
        command: "plex-collection-add",
        result: {
          collectionName: "Test Collection",
          itemsAdded: 24,
          totalItems: 24,
          mediaType: "artist",
          metadataType: 8,
        },
      });

      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "json", "plex", "collection", "list", "--library", "Music"],
        { from: "node" },
      );
      expect(mockFormatters.formatOutput).toHaveBeenLastCalledWith("json", {
        command: "plex-collection-list",
        result: {
          collections: [
            {
              title: "Test Collection",
              itemCount: 24,
              smart: false,
              mediaType: "album",
              metadataType: 9,
              addedAt: 1700000000,
            },
          ],
          total: 1,
        },
      });

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "json",
          "plex",
          "collection",
          "show",
          "Test Collection",
          "--library",
          "Music",
        ],
        { from: "node" },
      );
      expect(mockFormatters.formatOutput).toHaveBeenLastCalledWith("json", {
        command: "plex-collection-show",
        result: {
          title: "Test Collection",
          itemCount: 24,
          smart: false,
          mediaType: "album",
          metadataType: 9,
          summary: "Collection summary",
          addedAt: 1700000000,
          updatedAt: 1700000100,
        },
      });

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "json",
          "plex",
          "collection",
          "delete",
          "Test Collection",
          "--library",
          "Music",
          "--yes",
        ],
        { from: "node" },
      );
      expect(mockFormatters.formatOutput).toHaveBeenLastCalledWith("json", {
        command: "plex-collection-delete",
        result: { collectionName: "Test Collection", deleted: true },
      });
    });
  });

  describe("export", () => {
    it("should call executePlaylistExport with correct options", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "export", "MyPlaylist", "/dest"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistExport).toHaveBeenCalledWith(
        expect.objectContaining({
          playlistName: "MyPlaylist",
          destination: "/dest",
        }),
      );
    });

    it("should pass hardlink option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "export", "MyPlaylist", "/dest", "--hardlink"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistExport).toHaveBeenCalledWith(
        expect.objectContaining({
          playlistName: "MyPlaylist",
          destination: "/dest",
          hardlink: true,
        }),
      );
    });

    it("should pass convert option", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "plex",
          "playlist",
          "export",
          "MyPlaylist",
          "/dest",
          "--convert",
          "mp3",
        ],
        { from: "node" },
      );

      expect(mockActions.executePlaylistExport).toHaveBeenCalledWith(
        expect.objectContaining({
          playlistName: "MyPlaylist",
          destination: "/dest",
          convertFormat: "mp3",
        }),
      );
    });

    it("should pass workers option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "export", "MyPlaylist", "/dest", "-w", "8"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistExport).toHaveBeenCalledWith(
        expect.objectContaining({
          workers: 8,
        }),
      );
    });

    it("should pass dry-run option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "export", "MyPlaylist", "/dest", "--dry-run"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistExport).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: true,
        }),
      );
    });

    it("should pass plex-scan option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "export", "MyPlaylist", "/dest", "--plex-scan"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistExport).toHaveBeenCalledWith(
        expect.objectContaining({
          plexScan: true,
        }),
      );
    });

    it("should pass preserve-structure option", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "plex",
          "playlist",
          "export",
          "MyPlaylist",
          "/dest",
          "--preserve-structure",
        ],
        { from: "node" },
      );

      expect(mockActions.executePlaylistExport).toHaveBeenCalledWith(
        expect.objectContaining({
          preserveStructure: true,
        }),
      );
    });

    it("should handle playlist names with spaces", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "export", "My Playlist With Spaces", "/dest"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistExport).toHaveBeenCalledWith(
        expect.objectContaining({
          playlistName: "My Playlist With Spaces",
        }),
      );
    });

    it("should set exit code on failure", async () => {
      mockActions.executePlaylistExport.mockResolvedValue({
        playlistName: "Test Playlist",
        totalTracks: 10,
        created: 8,
        skipped: 0,
        failed: [{ path: "/test/file.flac", message: "Permission denied" }],
        totalSize: 800000,
      });

      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "export", "MyPlaylist", "/dest"],
        { from: "node" },
      );

      expect(process.exitCode).toBe(1);
    });
  });

  describe("sync", () => {
    it("should call executePlaylistSync with correct options", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "sync", "MyPlaylist", "/dest"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistSync).toHaveBeenCalledWith(
        expect.objectContaining({
          playlistName: "MyPlaylist",
          destination: "/dest",
        }),
      );
    });

    it("should pass deleteRemoved option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "sync", "MyPlaylist", "/dest", "--delete-removed"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistSync).toHaveBeenCalledWith(
        expect.objectContaining({
          playlistName: "MyPlaylist",
          destination: "/dest",
          deleteRemoved: true,
        }),
      );
    });

    it("should pass hardlink option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "sync", "MyPlaylist", "/dest", "--hardlink"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistSync).toHaveBeenCalledWith(
        expect.objectContaining({
          hardlink: true,
        }),
      );
    });

    it("should pass convert option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "sync", "MyPlaylist", "/dest", "--convert", "aac"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistSync).toHaveBeenCalledWith(
        expect.objectContaining({
          convertFormat: "aac",
        }),
      );
    });

    it("should pass dry-run option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "sync", "MyPlaylist", "/dest", "--dry-run"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistSync).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: true,
        }),
      );
    });

    it("should pass plex-scan option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "sync", "MyPlaylist", "/dest", "--plex-scan"],
        { from: "node" },
      );

      expect(mockActions.executePlaylistSync).toHaveBeenCalledWith(
        expect.objectContaining({
          plexScan: true,
        }),
      );
    });

    it("should pass preserve-structure option", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "plex",
          "playlist",
          "sync",
          "MyPlaylist",
          "/dest",
          "--preserve-structure",
        ],
        { from: "node" },
      );

      expect(mockActions.executePlaylistSync).toHaveBeenCalledWith(
        expect.objectContaining({
          preserveStructure: true,
        }),
      );
    });

    it("should set exit code on failure", async () => {
      mockActions.executePlaylistSync.mockResolvedValue({
        playlistName: "Test Playlist",
        totalTracks: 10,
        created: 6,
        skipped: 0,
        removed: 2,
        failed: [{ path: "/test/file.flac", message: "Permission denied" }],
        totalSize: 600000,
      });

      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "sync", "MyPlaylist", "/dest"],
        { from: "node" },
      );

      expect(process.exitCode).toBe(1);
    });
  });

  describe("list", () => {
    it("should call listPlaylists with correct options", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "plex", "playlist", "list"], {
        from: "node",
      });

      expect(mockActions.listPlaylists).toHaveBeenCalledWith(expect.objectContaining({}));
    });

    it("should filter exportable playlists", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "list", "--exportable"],
        { from: "node" },
      );

      expect(mockActions.listPlaylists).toHaveBeenCalledWith(
        expect.objectContaining({
          exportable: true,
        }),
      );
    });

    it("should pass plex-url option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "list", "--plex-url", "http://custom:32400"],
        { from: "node" },
      );

      expect(mockActions.listPlaylists).toHaveBeenCalledWith(
        expect.objectContaining({
          plexUrl: "http://custom:32400",
        }),
      );
    });

    it("should pass plex-token option", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "list", "--plex-token", "my-token"],
        { from: "node" },
      );

      expect(mockActions.listPlaylists).toHaveBeenCalledWith(
        expect.objectContaining({
          plexToken: "my-token",
        }),
      );
    });

    it("should output JSON when --output json is used", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "json", "plex", "playlist", "list"],
        { from: "node" },
      );

      // The formatOutput function should be called with "json" format and the result data
      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          command: "plex-playlist-list",
          result: expect.objectContaining({
            playlists: expect.arrayContaining([
              expect.objectContaining({
                title: "Playlist 1",
                trackCount: 10,
                smart: false,
              }),
            ]),
            total: 2,
          }),
        }),
      );
    });

    it("should output YAML when --output yaml is used", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "yaml", "plex", "playlist", "list"],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "yaml",
        expect.objectContaining({
          command: "plex-playlist-list",
          result: expect.objectContaining({
            playlists: expect.arrayContaining([
              expect.objectContaining({
                title: "Playlist 1",
                trackCount: 10,
                smart: false,
              }),
            ]),
            total: 2,
          }),
        }),
      );
    });

    it("should not call formatOutput in default text mode", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "plex", "playlist", "list"], {
        from: "node",
      });

      // In text mode, formatOutput should NOT be called; human-readable output is used instead
      expect(mockFormatters.formatOutput).not.toHaveBeenCalled();
    });

    it("should handle empty playlist list with JSON output", async () => {
      mockActions.listPlaylists.mockResolvedValue([]);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "json", "plex", "playlist", "list"],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          result: expect.objectContaining({
            playlists: [],
            total: 0,
          }),
        }),
      );
    });
  });

  describe("list dynamic table width", () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    /**
     * Helper: extract rendered table text from console.error spy calls.
     * The table is the call that contains column separators from console-table-printer.
     */
    function getRenderedTableOutput(): string {
      return consoleErrorSpy.mock.calls.map((args: unknown[]) => String(args[0] ?? "")).join("\n");
    }

    it("should use getTerminalWidth for column budget calculation", async () => {
      mockGetTerminalWidth.mockReturnValue(80);

      await rootCommand.parseAsync(["node", "rfmedia", "plex", "playlist", "list"], {
        from: "node",
      });

      expect(mockGetTerminalWidth).toHaveBeenCalled();
      // Table should render without errors
      const output = getRenderedTableOutput();
      expect(output).toContain("Playlist 1");
    });

    it("should truncate long playlist names on narrow terminals", async () => {
      // Set a narrow terminal width where truncation must kick in
      mockGetTerminalWidth.mockReturnValue(50);

      const longTitle = "A Very Long Playlist Name That Should Be Truncated on Narrow Terminals";
      mockActions.listPlaylists.mockResolvedValue([
        {
          ratingKey: "1",
          title: longTitle,
          smart: false,
          leafCount: 10,
          duration: 300000,
          addedAt: 1700000000,
          updatedAt: 1700000000,
        },
      ]);

      await rootCommand.parseAsync(["node", "rfmedia", "plex", "playlist", "list"], {
        from: "node",
      });

      const output = getRenderedTableOutput();
      // The full title should NOT appear because the narrow terminal truncates it
      expect(output).not.toContain(longTitle);
      // The truncated version should contain an ellipsis marker
      expect(output).toContain("\u2026");
    });

    it("should show full playlist names on wide terminals", async () => {
      mockGetTerminalWidth.mockReturnValue(200);

      const normalTitle = "My Favorite Playlist";
      mockActions.listPlaylists.mockResolvedValue([
        {
          ratingKey: "1",
          title: normalTitle,
          smart: false,
          leafCount: 10,
          duration: 300000,
          addedAt: 1700000000,
          updatedAt: 1700000000,
        },
      ]);

      await rootCommand.parseAsync(["node", "rfmedia", "plex", "playlist", "list"], {
        from: "node",
      });

      const output = getRenderedTableOutput();
      // On a wide terminal, the full title should be visible
      expect(output).toContain(normalTitle);
    });

    it("should handle Unicode playlist names correctly", async () => {
      mockGetTerminalWidth.mockReturnValue(120);

      const unicodeTitle = "\u97F3\u697D\u30D7\u30EC\u30A4\u30EA\u30B9\u30C8 \uD83C\uDFB5"; // "音楽プレイリスト 🎵"
      mockActions.listPlaylists.mockResolvedValue([
        {
          ratingKey: "1",
          title: unicodeTitle,
          smart: false,
          leafCount: 5,
          duration: 180000,
          addedAt: 1700000000,
          updatedAt: 1700000000,
        },
      ]);

      await rootCommand.parseAsync(["node", "rfmedia", "plex", "playlist", "list"], {
        from: "node",
      });

      const output = getRenderedTableOutput();
      // At 120 columns the Unicode title should fit without truncation
      expect(output).toContain("\u97F3\u697D");
    });

    it("should truncate Unicode names on narrow terminals without breaking alignment", async () => {
      mockGetTerminalWidth.mockReturnValue(50);

      // Long CJK name (each character is 2 display columns)
      const longCjk =
        "\u97F3\u697D\u30D7\u30EC\u30A4\u30EA\u30B9\u30C8\u30B3\u30EC\u30AF\u30B7\u30E7\u30F3\u30D9\u30B9\u30C8\u30D2\u30C3\u30C8\u66F2\u96C6";
      mockActions.listPlaylists.mockResolvedValue([
        {
          ratingKey: "1",
          title: longCjk,
          smart: false,
          leafCount: 20,
          duration: 600000,
          addedAt: 1700000000,
          updatedAt: 1700000000,
        },
      ]);

      await rootCommand.parseAsync(["node", "rfmedia", "plex", "playlist", "list"], {
        from: "node",
      });

      const output = getRenderedTableOutput();
      // The full CJK string should be truncated
      expect(output).not.toContain(longCjk);
      // Table should still render (contains header)
      expect(output).toContain("Plex Playlists");
    });

    it("should use deterministic fallback width for non-TTY output", async () => {
      // Simulate non-TTY fallback (120 columns)
      mockGetTerminalWidth.mockReturnValue(120);

      await rootCommand.parseAsync(["node", "rfmedia", "plex", "playlist", "list"], {
        from: "node",
      });

      const output = getRenderedTableOutput();
      // Playlists should render with the fallback 120-column budget
      expect(output).toContain("Playlist 1");
      expect(output).toContain("Playlist 2");
    });

    it("should not affect machine format output when terminal width changes", async () => {
      mockGetTerminalWidth.mockReturnValue(40);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "json", "plex", "playlist", "list"],
        { from: "node" },
      );

      // Machine format should bypass table rendering entirely
      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          command: "plex-playlist-list",
          result: expect.objectContaining({
            playlists: expect.arrayContaining([
              expect.objectContaining({
                title: "Playlist 1",
              }),
            ]),
          }),
        }),
      );
      expect(mockGetTerminalWidth).not.toHaveBeenCalled();
      expect(getRenderedTableOutput()).toBe("");
    });

    it("should preserve column visibility at minimum width", async () => {
      // Set width to minimum usable threshold
      mockGetTerminalWidth.mockReturnValue(40);

      await rootCommand.parseAsync(["node", "rfmedia", "plex", "playlist", "list"], {
        from: "node",
      });

      const output = getRenderedTableOutput();
      // All column headers should still be present
      expect(output).toContain("Playlist");
      expect(output).toContain("Tracks");
      expect(output).toContain("Smart");
      expect(output).toContain("Duration");
    });
  });

  describe("collection create mode parity", () => {
    it("should pass create --mode artist as type=artist", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "plex",
          "collection",
          "create",
          "Female Country Pop",
          "--library",
          "Music",
          "--mode",
          "artist",
        ],
        { from: "node" },
      );

      expect(mockCollectionActions.executeCollectionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionName: "Female Country Pop",
          library: "Music",
          type: "artist",
        }),
      );
    });

    it("should pass create --add-artist alias as type=artist", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "plex",
          "collection",
          "create",
          "Female RNB",
          "--library",
          "Music",
          "--add-artist",
        ],
        { from: "node" },
      );

      expect(mockCollectionActions.executeCollectionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionName: "Female RNB",
          library: "Music",
          type: "artist",
        }),
      );
    });

    it("should keep --type behavior for create", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "plex",
          "collection",
          "create",
          "Female Pop Albums",
          "--library",
          "Music",
          "--type",
          "album",
        ],
        { from: "node" },
      );

      expect(mockCollectionActions.executeCollectionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionName: "Female Pop Albums",
          library: "Music",
          type: "album",
        }),
      );
    });

    it("should reject conflicting --type and --mode values", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "plex",
          "collection",
          "create",
          "Conflict Test",
          "--library",
          "Music",
          "--type",
          "track",
          "--mode",
          "artist",
        ],
        { from: "node" },
      );

      expect(mockCollectionActions.executeCollectionCreate).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Conflicting collection type options"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("should reject conflicting --mode and --add-* alias values", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "plex",
          "collection",
          "create",
          "Conflict Test",
          "--library",
          "Music",
          "--mode",
          "track",
          "--add-artist",
        ],
        { from: "node" },
      );

      expect(mockCollectionActions.executeCollectionCreate).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Conflicting create mode options"),
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe("error handling", () => {
    it("should handle export action errors gracefully", async () => {
      mockActions.executePlaylistExport.mockRejectedValue(new Error("Playlist not found"));

      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "export", "NonExistent", "/dest"],
        { from: "node" },
      );

      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Playlist export failed: Playlist not found"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("should handle sync action errors gracefully", async () => {
      mockActions.executePlaylistSync.mockRejectedValue(new Error("Connection refused"));

      await rootCommand.parseAsync(
        ["node", "rfmedia", "plex", "playlist", "sync", "MyPlaylist", "/dest"],
        { from: "node" },
      );

      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Playlist sync failed: Connection refused"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("should handle list action errors gracefully", async () => {
      mockActions.listPlaylists.mockRejectedValue(new Error("Invalid token"));

      await rootCommand.parseAsync(["node", "rfmedia", "plex", "playlist", "list"], {
        from: "node",
      });

      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list playlists: Invalid token"),
      );
      expect(process.exitCode).toBe(1);
    });
  });
});
