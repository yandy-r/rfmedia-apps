/**
 * Type definitions for shell completion functionality.
 */

/**
 * Supported shell types for autocompletion.
 */
export type SupportedShell = "bash" | "zsh" | "fish";

/**
 * Array of all supported shell types.
 */
export const SUPPORTED_SHELLS: readonly SupportedShell[] = ["bash", "zsh", "fish"] as const;

/**
 * Options for the completion command.
 */
export interface CompletionOptions {
  /** Target shell for completion script generation */
  shell: SupportedShell;
  /** Install completion script to shell configuration */
  install: boolean;
  /** Preview installation without making changes */
  dryRun: boolean;
  /** Skip confirmation prompts during installation */
  force: boolean;
}

/**
 * Result of completion script generation or installation.
 */
export interface CompletionResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** Generated completion script content */
  script: string;
  /** Path where script was installed (if install was requested) */
  installedPath?: string;
  /** Error message if operation failed */
  error?: string;
  /** Whether completion was already installed (skipped) */
  alreadyInstalled?: boolean;
}
