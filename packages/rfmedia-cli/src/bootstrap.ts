#!/usr/bin/env node
/**
 * Bootstrap entrypoint for rfmedia CLI.
 *
 * This minimal entrypoint handles secrets re-execution BEFORE loading any
 * application modules. This ensures that if --use-dotenvx or --use-op options
 * are provided, the CLI re-executes under the secrets wrapper before any
 * imports that might read environment variables during module initialization.
 *
 * Re-execution flow:
 * 1. Parse argv to detect --use-dotenvx or --use-op options
 * 2. If detected, re-exec under dotenvx/op wrapper with secrets injected
 * 3. Otherwise, proceed to load the main CLI module
 *
 * This prevents the timing issue where modules import and initialize before
 * secrets are available in the environment.
 *
 * @module rfmedia-cli/bootstrap
 */

// ONLY import the re-exec utilities - no other app code that might read env vars
import { detectSecretsOption, executeWithSecretsWrapper } from "./lib/secrets-reexec.js";

// Check for secrets injection options BEFORE any other imports
const secretsResult = detectSecretsOption(process.argv);

if (secretsResult.error) {
  console.error(`Error: ${secretsResult.error}`);
  process.exit(1);
}

if (secretsResult.shouldReexec) {
  // Re-execute under secrets wrapper (dotenvx or 1Password CLI)
  const exitCode = await executeWithSecretsWrapper(secretsResult);
  process.exit(exitCode);
}

// Now that secrets are injected (or not needed), import and run the main CLI
// This dynamic import ensures all downstream modules initialize with secrets available
try {
  const { program } = await import("./cli.js");
  await program.parseAsync(process.argv);
} catch (error) {
  // Handle errors gracefully with user-friendly output
  const { handleCliError } = await import("@rfmedia/common");
  handleCliError(error);
}
