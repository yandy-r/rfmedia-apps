import type { McpToolDefinition } from "@rfmedia/common";

import { rfmediaActionAdapters } from "./adapters.js";
import { RFMEDIA_MCP_TOOL_NAMES, rfmediaMcpSchemas } from "./schema.js";
import type { FilterListToolArgs, FilterShowToolArgs } from "./schema.js";

export const rfmediaReadTools: readonly McpToolDefinition<unknown, unknown>[] = [
  {
    name: RFMEDIA_MCP_TOOL_NAMES.filterList,
    description: "List configured smart filters with match strategy and rule counts.",
    inputSchema: rfmediaMcpSchemas.filterList.input,
    outputSchema: rfmediaMcpSchemas.filterList.output,
    handler: async (args) => rfmediaActionAdapters.filterList(args as FilterListToolArgs),
  },
  {
    name: RFMEDIA_MCP_TOOL_NAMES.filterShow,
    description: "Show a single smart filter definition and formatted rule tree.",
    inputSchema: rfmediaMcpSchemas.filterShow.input,
    outputSchema: rfmediaMcpSchemas.filterShow.output,
    handler: async (args) => rfmediaActionAdapters.filterShow(args as FilterShowToolArgs),
  },
];
