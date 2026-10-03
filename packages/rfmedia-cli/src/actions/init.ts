/**
 * Init action for rfmedia CLI.
 *
 * Generates a configuration file template with all available options.
 */

import { logError, logInfo, logSuccess } from "../lib/logger.js";
import { getDefaultConfigPath, writeConfigTemplate } from "../lib/config.js";

/**
 * Options for the init action.
 */
export interface InitOptions {
  /** Custom path for the config file */
  path?: string;
  /** Write to global config location (~/.rfmedia.yaml) */
  global: boolean;
  /** Overwrite existing config file */
  force: boolean;
  /** Merge template with existing config instead of overwriting (default: true) */
  merge: boolean;
}

/**
 * Result of the init action.
 */
export interface InitResult {
  /** Whether the config file was created successfully */
  created: boolean;
  /** Path where the config file was written or would be written */
  path: string;
  /** Whether existing config was merged with template */
  merged?: boolean;
  /** Error message if creation failed */
  error?: string;
}

/**
 * Executes the init action to create a configuration file template.
 *
 * @param options - Init action options
 * @returns Result containing success status and path
 */
export async function executeInit(options: InitOptions): Promise<InitResult> {
  // Determine target path
  const targetPath = options.path ?? getDefaultConfigPath(options.global);

  logInfo(`Creating config file at: ${targetPath}`);

  try {
    const { merged } = await writeConfigTemplate(targetPath, options.force, options.merge);
    if (merged) {
      logSuccess(`Config file updated (merged with existing): ${targetPath}`);
    } else {
      logSuccess(`Config file created: ${targetPath}`);
    }

    return {
      created: true,
      path: targetPath,
      merged,
    };
  } catch (err) {
    const error = err as Error;
    logError(error.message);

    return {
      created: false,
      path: targetPath,
      error: error.message,
    };
  }
}
