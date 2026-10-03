/**
 * Environment variable injection tools for rfmedia CLI
 *
 * Supports:
 * - dotenvx: Local .env file with encryption support
 * - op (1Password CLI): Secrets from 1Password vaults
 *
 * When --use-dotenvx or --use-op is specified, the CLI re-executes itself
 * with the appropriate wrapper command to inject environment variables
 * before config loading.
 */

// Re-export shared types and functions from @rfmedia/common for backwards compatibility
// CRITICAL: These re-exports are required for secrets-reexec.ts which imports from local env-tools
export { checkDotenvx, checkOp, envFileExists } from "@rfmedia/common";
export type { ToolCheckResult } from "@rfmedia/common";

/**
 * Build command arguments for running with environment injection
 *
 * @param tool - The tool to use ('dotenvx' or 'op')
 * @param envFile - Path to the environment file
 * @returns Command and arguments to prepend to the CLI command
 */
export function buildEnvCommand(
  tool: "dotenvx" | "op",
  envFile: string,
): {
  command: string;
  args: string[];
} {
  switch (tool) {
    case "dotenvx":
      return {
        command: "dotenvx",
        args: ["run", "-q", "-f", envFile, "--"],
      };

    case "op":
      // Masking rewrites resolved values in captured stdout.
      return {
        command: "op",
        args: ["run", "--no-masking", "--env-file", envFile, "--"],
      };
  }
}
