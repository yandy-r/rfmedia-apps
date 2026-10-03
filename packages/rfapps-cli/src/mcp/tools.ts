import type { McpAnyToolDefinition } from "@rfmedia/common";

import { rfappsMutationTools } from "./tools-mutate.js";
import { rfappsReadTools } from "./tools-read.js";

export const rfappsMcpTools: readonly McpAnyToolDefinition[] = [
  ...rfappsReadTools,
  ...rfappsMutationTools,
];
