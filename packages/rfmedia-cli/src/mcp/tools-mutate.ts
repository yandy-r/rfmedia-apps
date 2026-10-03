import type { McpToolDefinition } from "@rfmedia/common";

import { rfmediaActionAdapters } from "./adapters.js";
import { RFMEDIA_MCP_TOOL_NAMES, rfmediaMcpSchemas } from "./schema.js";
import type {
  CopyAlbumToolArgs,
  CopyFilterToolArgs,
  PlexQueryToolArgs,
  SyncToolArgs,
} from "./schema.js";

export const rfmediaMutationTools: readonly McpToolDefinition<unknown, unknown>[] = [
  {
    name: RFMEDIA_MCP_TOOL_NAMES.copyAlbum,
    description: "Copy album sources with suffix ranges, tracking, and optional conversion.",
    inputSchema: rfmediaMcpSchemas.copyAlbum.input,
    outputSchema: rfmediaMcpSchemas.copyAlbum.output,
    handler: async (args) => rfmediaActionAdapters.copyAlbum(args as CopyAlbumToolArgs),
  },
  {
    name: RFMEDIA_MCP_TOOL_NAMES.copyFilter,
    description:
      "Copy filtered tracks using ratings or smart-filter criteria with optional mutation side effects.",
    inputSchema: rfmediaMcpSchemas.copyFilter.input,
    outputSchema: rfmediaMcpSchemas.copyFilter.output,
    handler: async (args) => rfmediaActionAdapters.copyFilter(args as CopyFilterToolArgs),
  },
  {
    name: RFMEDIA_MCP_TOOL_NAMES.sync,
    description: "Run incremental sync from file or source lists and persist inventory updates.",
    inputSchema: rfmediaMcpSchemas.sync.input,
    outputSchema: rfmediaMcpSchemas.sync.output,
    handler: async (args) => rfmediaActionAdapters.sync(args as SyncToolArgs),
  },
  {
    name: RFMEDIA_MCP_TOOL_NAMES.plexQuery,
    description: "Query Plex libraries and optionally persist query metadata/results.",
    inputSchema: rfmediaMcpSchemas.plexQuery.input,
    outputSchema: rfmediaMcpSchemas.plexQuery.output,
    handler: async (args) => rfmediaActionAdapters.plexQuery(args as PlexQueryToolArgs),
  },
];
