import type { McpToolDefinition } from "@rfmedia/common";

import { rfappsActionAdapters } from "./adapters.js";
import { withStateLock } from "../lib/state-lock.js";
import { RFAPPS_MCP_TOOL_NAMES, rfappsMcpSchemas } from "./schema.js";
import type {
  ApplyToolArgs,
  DeleteToolArgs,
  DeployToolArgs,
  DriftDetectToolArgs,
  DriftImportToolArgs,
  PruneToolArgs,
  PullToolArgs,
  RebuildToolArgs,
  RollbackToolArgs,
} from "./schema.js";

interface LockableMutationArgs {
  readonly dryRun?: boolean;
}

async function runMutationWithStateLock<TResult>(
  operation: string,
  args: LockableMutationArgs,
  execute: () => Promise<TResult>,
  mutates = true,
): Promise<TResult> {
  if (!mutates || args.dryRun === true) {
    return execute();
  }
  return withStateLock(operation, async () => execute());
}

export const rfappsMutationTools: readonly McpToolDefinition<unknown, unknown>[] = [
  {
    name: RFAPPS_MCP_TOOL_NAMES.pull,
    description: "Pull Docker images for targeted services.",
    inputSchema: rfappsMcpSchemas.pull.input,
    outputSchema: rfappsMcpSchemas.pull.output,
    handler: async (args) => {
      const parsed = args as PullToolArgs;
      return runMutationWithStateLock("pull", parsed, () => rfappsActionAdapters.pull(parsed));
    },
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.deploy,
    description: "Deploy services (pull + start) with rfapps safety checks.",
    inputSchema: rfappsMcpSchemas.deploy.input,
    outputSchema: rfappsMcpSchemas.deploy.output,
    handler: async (args) => {
      const parsed = args as DeployToolArgs;
      return runMutationWithStateLock("deploy", parsed, () => rfappsActionAdapters.deploy(parsed));
    },
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.rebuild,
    description: "Rebuild services (stop + build + start).",
    inputSchema: rfappsMcpSchemas.rebuild.input,
    outputSchema: rfappsMcpSchemas.rebuild.output,
    handler: async (args) => {
      const parsed = args as RebuildToolArgs;
      return runMutationWithStateLock("rebuild", parsed, () =>
        rfappsActionAdapters.rebuild(parsed),
      );
    },
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.stop,
    description: "Stop targeted services.",
    inputSchema: rfappsMcpSchemas.stop.input,
    outputSchema: rfappsMcpSchemas.stop.output,
    handler: async (args) => {
      const parsed = args as PullToolArgs;
      return runMutationWithStateLock("stop", parsed, () => rfappsActionAdapters.stop(parsed));
    },
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.delete,
    description: "Delete services and optionally volumes/images.",
    inputSchema: rfappsMcpSchemas.delete.input,
    outputSchema: rfappsMcpSchemas.delete.output,
    handler: async (args) => {
      const parsed = args as DeleteToolArgs;
      return runMutationWithStateLock("delete", parsed, () => rfappsActionAdapters.delete(parsed));
    },
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.prune,
    description: "Prune services with smart image cleanup.",
    inputSchema: rfappsMcpSchemas.prune.input,
    outputSchema: rfappsMcpSchemas.prune.output,
    handler: async (args) => {
      const parsed = args as PruneToolArgs;
      return runMutationWithStateLock("prune", parsed, () => rfappsActionAdapters.prune(parsed));
    },
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.apply,
    description: "Apply a saved rfapps plan file.",
    inputSchema: rfappsMcpSchemas.apply.input,
    outputSchema: rfappsMcpSchemas.apply.output,
    handler: async (args) => {
      const parsed = args as ApplyToolArgs;
      return runMutationWithStateLock("apply", parsed, () => rfappsActionAdapters.apply(parsed));
    },
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.rollback,
    description: "Rollback a service to a previous deployment.",
    inputSchema: rfappsMcpSchemas.rollback.input,
    outputSchema: rfappsMcpSchemas.rollback.output,
    handler: async (args) => {
      const parsed = args as RollbackToolArgs;
      return runMutationWithStateLock("rollback", parsed, () =>
        rfappsActionAdapters.rollback(parsed),
      );
    },
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.driftReconcile,
    description:
      "Report desired-versus-actual drift and optionally reconcile it with explicit auto-apply authorization.",
    inputSchema: rfappsMcpSchemas.driftReconcile.input,
    outputSchema: rfappsMcpSchemas.driftReconcile.output,
    handler: async (args) => {
      const parsed = rfappsMcpSchemas.driftReconcile.input.parse(args);
      return runMutationWithStateLock(
        "reconcile",
        parsed,
        () => rfappsActionAdapters.driftReconcile(parsed),
        parsed.autoApply === true,
      );
    },
  },
  {
    name: RFAPPS_MCP_TOOL_NAMES.driftImport,
    description: "Import runtime drift back into compose.yml.",
    inputSchema: rfappsMcpSchemas.driftImport.input,
    outputSchema: rfappsMcpSchemas.driftImport.output,
    handler: async (args) => {
      const parsed = args as DriftImportToolArgs;
      return runMutationWithStateLock("drift-import", parsed, () =>
        rfappsActionAdapters.driftImport(parsed),
      );
    },
  },
];
