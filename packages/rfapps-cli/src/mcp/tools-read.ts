import type { McpToolDefinition } from "@rfmedia/common";

import { rfappsActionAdapters } from "./adapters.js";
import { withStateLock } from "../lib/state-lock.js";
import { RFAPPS_MCP_TOOL_NAMES, rfappsMcpSchemas } from "./schema.js";
import type {
  DriftDetectToolArgs,
  DriftShowToolArgs,
  HealthToolArgs,
  HistoryToolArgs,
  PlanToolArgs,
  StatusToolArgs,
} from "./schema.js";

export const rfappsReadTools: readonly McpToolDefinition<unknown, unknown>[] = [
  {
    name: RFAPPS_MCP_TOOL_NAMES.status,
    description: "Show Docker service status, health, and runtime metadata.",
    inputSchema: rfappsMcpSchemas.status.input,
    outputSchema: rfappsMcpSchemas.status.output,
    handler: async (args) => rfappsActionAdapters.status(args as StatusToolArgs),
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.health,
    description: "Check dependency readiness signals for target services.",
    inputSchema: rfappsMcpSchemas.health.input,
    outputSchema: rfappsMcpSchemas.health.output,
    handler: async (args) => rfappsActionAdapters.health(args as HealthToolArgs),
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.plan,
    description: "Generate a deployment plan that previews compose changes.",
    inputSchema: rfappsMcpSchemas.plan.input,
    outputSchema: rfappsMcpSchemas.plan.output,
    handler: async (args) => {
      const parsed = args as PlanToolArgs;
      if (parsed.apply !== true || parsed.dryRun === true) {
        return rfappsActionAdapters.plan(parsed);
      }
      return withStateLock("plan", async () => rfappsActionAdapters.plan(parsed));
    },
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.history,
    description: "Read deployment history from rfapps state storage.",
    inputSchema: rfappsMcpSchemas.history.input,
    outputSchema: rfappsMcpSchemas.history.output,
    handler: async (args) => rfappsActionAdapters.history(args as HistoryToolArgs),
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.driftDetect,
    description: "Detect drift between compose configuration and running containers.",
    inputSchema: rfappsMcpSchemas.driftDetect.input,
    outputSchema: rfappsMcpSchemas.driftDetect.output,
    handler: async (args) => rfappsActionAdapters.driftDetect(args as DriftDetectToolArgs),
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.driftShow,
    description: "Show detailed drift for a specific service.",
    inputSchema: rfappsMcpSchemas.driftShow.input,
    outputSchema: rfappsMcpSchemas.driftShow.output,
    handler: async (args) => rfappsActionAdapters.driftShow(args as DriftShowToolArgs),
  },
];
