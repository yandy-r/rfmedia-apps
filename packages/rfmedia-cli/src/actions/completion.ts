/**
 * Completion action for rfmedia CLI.
 *
 * Generates and optionally installs shell completion scripts
 * for bash, zsh, and fish shells.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { logInfo, logSuccess, logWarn, logDebug } from "../lib/logger.js";
import {
  generateBashCompletion,
  generateZshCompletion,
  generateFishCompletion,
} from "../lib/shell-completions/index.js";
import type { CompletionOptions, CompletionResult, SupportedShell } from "../types/index.js";

/**
 * Marker comment used to detect existing installation.
 */
const INSTALL_MARKER = "# rfmedia shell completion";

/**
 * Shell configuration file paths.
 */
interface ShellPaths {
  /** Path to the config file that will source the completion */
  configFile: string;
  /** Path where completion script is installed (zsh/fish only) */
  completionFile?: string;
  /** Line to add to config file (bash only) */
  evalLine?: string;
  /** Setup commands to add to config file (zsh only) */
  setupLines?: string[];
}

/**
 * Gets the installation paths for a given shell.
 *
 * @param shell - Target shell type
 * @returns Shell configuration paths
 */
function getShellPaths(shell: SupportedShell): ShellPaths {
  const home = os.homedir();

  switch (shell) {
    case "bash":
      return {
        configFile: path.join(home, ".bashrc"),
      };
    case "zsh":
      return {
        configFile: path.join(home, ".zshrc"),
        completionFile: path.join(home, ".zfunc", "_rfmedia"),
        setupLines: [
          "# rfmedia shell completion",
          "fpath=(~/.zfunc $fpath)",
          "autoload -Uz compinit && compinit",
        ],
      };
    case "fish":
      return {
        configFile: path.join(home, ".config", "fish", "config.fish"),
        completionFile: path.join(home, ".config", "fish", "completions", "rfmedia.fish"),
      };
  }
}

/**
 * Generates the completion script for a given shell.
 *
 * @param shell - Target shell type
 * @returns Completion script content
 */
function generateScript(shell: SupportedShell): string {
  switch (shell) {
    case "bash":
      return generateBashCompletion();
    case "zsh":
      return generateZshCompletion();
    case "fish":
      return generateFishCompletion();
  }
}

/**
 * Checks if completion is already installed for a shell.
 *
 * @param shell - Target shell type
 * @returns true if already installed
 */
async function isAlreadyInstalled(shell: SupportedShell): Promise<boolean> {
  const paths = getShellPaths(shell);

  try {
    // For zsh and fish, check if the completion file exists
    if (paths.completionFile) {
      try {
        await fs.access(paths.completionFile);
        return true;
      } catch {
        return false;
      }
    }

    // For bash, check if the marker exists in the config file
    const content = await fs.readFile(paths.configFile, "utf-8");
    return content.includes(INSTALL_MARKER);
  } catch {
    return false;
  }
}

/**
 * Ensures a directory exists, creating it if necessary.
 *
 * @param dir - Directory path to ensure
 */
async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Installs completion script for bash shell.
 *
 * Appends the completion script directly to ~/.bashrc.
 *
 * @param script - Completion script content
 * @param dryRun - If true, don't modify files
 * @returns Installation path
 */
async function installBashCompletion(script: string, dryRun: boolean): Promise<string> {
  const paths = getShellPaths("bash");

  if (dryRun) {
    logInfo(`[DRY RUN] Would append completion script to: ${paths.configFile}`);
    return paths.configFile;
  }

  // Read existing content to append
  let existingContent = "";
  try {
    existingContent = await fs.readFile(paths.configFile, "utf-8");
  } catch {
    // File doesn't exist, that's fine
  }

  // Append completion script with separator
  const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
  const newContent = existingContent + separator + script;
  await fs.writeFile(paths.configFile, newContent, "utf-8");

  return paths.configFile;
}

/**
 * Installs completion script for zsh shell.
 *
 * Writes completion to ~/.zfunc/_rfmedia and updates ~/.zshrc if needed.
 *
 * @param script - Completion script content
 * @param dryRun - If true, don't modify files
 * @returns Installation path
 */
async function installZshCompletion(script: string, dryRun: boolean): Promise<string> {
  const paths = getShellPaths("zsh");
  const completionFile = paths.completionFile!;
  const zfuncDir = path.dirname(completionFile);

  if (dryRun) {
    logInfo(`[DRY RUN] Would create directory: ${zfuncDir}`);
    logInfo(`[DRY RUN] Would write completion script to: ${completionFile}`);
    logInfo(`[DRY RUN] Would update ${paths.configFile} with fpath setup`);
    return completionFile;
  }

  // Create ~/.zfunc directory if needed
  await ensureDir(zfuncDir);

  // Write completion script
  await fs.writeFile(completionFile, script, "utf-8");
  logDebug(`Wrote completion script to: ${completionFile}`);

  // Check if ~/.zshrc needs fpath setup
  let zshrcContent = "";
  try {
    zshrcContent = await fs.readFile(paths.configFile, "utf-8");
  } catch {
    // File doesn't exist, that's fine
  }

  // Check if fpath setup is already present
  if (!zshrcContent.includes("~/.zfunc")) {
    const setupLines = paths.setupLines!.join("\n");
    const separator = zshrcContent.endsWith("\n") ? "\n" : "\n\n";
    const newContent = zshrcContent + separator + setupLines + "\n";
    await fs.writeFile(paths.configFile, newContent, "utf-8");
    logDebug(`Updated ${paths.configFile} with fpath setup`);
  }

  return completionFile;
}

/**
 * Installs completion script for fish shell.
 *
 * Writes completion to ~/.config/fish/completions/rfmedia.fish.
 *
 * @param script - Completion script content
 * @param dryRun - If true, don't modify files
 * @returns Installation path
 */
async function installFishCompletion(script: string, dryRun: boolean): Promise<string> {
  const paths = getShellPaths("fish");
  const completionFile = paths.completionFile!;
  const completionsDir = path.dirname(completionFile);

  if (dryRun) {
    logInfo(`[DRY RUN] Would create directory: ${completionsDir}`);
    logInfo(`[DRY RUN] Would write completion script to: ${completionFile}`);
    return completionFile;
  }

  // Create completions directory if needed
  await ensureDir(completionsDir);

  // Write completion script
  await fs.writeFile(completionFile, script, "utf-8");

  return completionFile;
}

/**
 * Executes the completion action.
 *
 * Generates a shell completion script and optionally installs it.
 *
 * @param options - Completion options
 * @returns Result containing success status and script content
 */
export async function executeCompletion(options: CompletionOptions): Promise<CompletionResult> {
  const { shell, install, dryRun, force } = options;

  logDebug(`Generating ${shell} completion script`);

  // Generate the completion script
  const script = generateScript(shell);

  // If not installing, just return the script
  if (!install) {
    return {
      success: true,
      script,
    };
  }

  // Check if already installed
  const alreadyInstalled = await isAlreadyInstalled(shell);
  if (alreadyInstalled && !force) {
    logWarn(`Completion for ${shell} appears to already be installed`);
    logInfo("Use --force to overwrite existing installation");
    return {
      success: true,
      script,
      alreadyInstalled: true,
    };
  }

  // Install the completion script
  logInfo(`Installing ${shell} completion...`);

  let installedPath: string;
  try {
    switch (shell) {
      case "bash":
        installedPath = await installBashCompletion(script, dryRun);
        break;
      case "zsh":
        installedPath = await installZshCompletion(script, dryRun);
        break;
      case "fish":
        installedPath = await installFishCompletion(script, dryRun);
        break;
    }

    if (dryRun) {
      logInfo("[DRY RUN] No files were modified");
    } else {
      logSuccess(`Completion script installed to: ${installedPath}`);
      logInfo("Restart your shell or run:");
      switch (shell) {
        case "bash":
          logInfo("  source ~/.bashrc");
          break;
        case "zsh":
          logInfo("  source ~/.zshrc");
          break;
        case "fish":
          logInfo("  Completions are loaded automatically");
          break;
      }
    }

    return {
      success: true,
      script,
      installedPath,
    };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      script,
      error: error.message,
    };
  }
}
