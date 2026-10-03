import type { McpAnyToolDefinition } from "@rfmedia/common";

import { rfmediaMutationTools } from "./tools-mutate.js";
import { rfmediaReadTools } from "./tools-read.js";

export const rfmediaMcpTools: readonly McpAnyToolDefinition[] = [
  ...rfmediaReadTools,
  ...rfmediaMutationTools,
];
