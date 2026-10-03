/**
 * User prompt utilities for rfmedia CLI.
 *
 * Provides interactive prompts using Node.js readline for:
 * - Yes/No confirmation
 * - Option selection from a list
 * - Text input
 * - Number input
 */

import { createInterface, type Interface } from "node:readline";

/**
 * Option for selectOption prompt.
 */
export interface SelectOption<T> {
  /** Display label for the option */
  label: string;
  /** Value returned when this option is selected */
  value: T;
  /** Optional shortcut key (single character) */
  key?: string;
}

/**
 * Creates a readline interface for interactive prompts.
 * Uses stderr for output to keep stdout clean for JSON/piped output.
 */
function createPromptInterface(): Interface {
  return createInterface({
    input: process.stdin,
    output: process.stderr,
  });
}

/**
 * Prompts the user for a yes/no confirmation.
 *
 * Defaults to No if the user presses Enter without input.
 * Accepts 'y', 'yes' (case-insensitive) as confirmation.
 *
 * @param message - The prompt message to display
 * @returns true if user confirms, false otherwise
 */
export async function confirm(message: string): Promise<boolean> {
  const rl = createPromptInterface();

  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();

      // Default to No if user presses Enter without input
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "y" || trimmed === "yes") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

/**
 * Prompts the user to select from a list of options.
 *
 * Displays numbered options and accepts either the number or shortcut key.
 * Re-prompts on invalid input.
 *
 * @param message - The prompt message to display
 * @param options - Array of options to select from
 * @returns The value of the selected option
 *
 * @example
 * const match = await selectOption('Select match type:', [
 *   { label: 'All rules must match (AND)', value: 'all', key: 'a' },
 *   { label: 'Any rule must match (OR)', value: 'any', key: 'o' },
 * ]);
 */
export async function selectOption<T>(message: string, options: SelectOption<T>[]): Promise<T> {
  const rl = createPromptInterface();

  // Build display string
  const optionLines = options.map((opt, i) => {
    const keyHint = opt.key ? ` [${opt.key}]` : "";
    return `  ${i + 1}. ${opt.label}${keyHint}`;
  });

  const prompt = `${message}\n${optionLines.join("\n")}\nSelect (1-${options.length}): `;

  return new Promise<T>((resolve) => {
    const askQuestion = (): void => {
      rl.question(prompt, (answer) => {
        const trimmed = answer.trim().toLowerCase();

        // Check for shortcut key match
        const keyMatch = options.find((opt) => opt.key?.toLowerCase() === trimmed);
        if (keyMatch) {
          rl.close();
          resolve(keyMatch.value);
          return;
        }

        // Check for number selection
        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num >= 1 && num <= options.length) {
          rl.close();
          const selected = options[num - 1];
          if (selected) {
            resolve(selected.value);
            return;
          }
        }

        // Invalid input - re-prompt
        process.stderr.write(`Invalid selection. Please enter 1-${options.length}.\n`);
        askQuestion();
      });
    };

    askQuestion();
  });
}

/**
 * Prompts the user for text input.
 *
 * @param message - The prompt message to display
 * @param options - Optional configuration
 * @param options.defaultValue - Default value if user presses Enter without input
 * @param options.required - If true, re-prompts on empty input (default: false)
 * @returns The user's input (trimmed)
 *
 * @example
 * const name = await inputText('Enter filter name:', { required: true });
 */
export async function inputText(
  message: string,
  options?: { defaultValue?: string; required?: boolean },
): Promise<string> {
  const rl = createPromptInterface();
  const { defaultValue, required = false } = options ?? {};

  const defaultHint = defaultValue ? ` [${defaultValue}]` : "";
  const prompt = `${message}${defaultHint} `;

  return new Promise<string>((resolve) => {
    const askQuestion = (): void => {
      rl.question(prompt, (answer) => {
        const trimmed = answer.trim();

        if (trimmed === "" && defaultValue !== undefined) {
          rl.close();
          resolve(defaultValue);
          return;
        }

        if (trimmed === "" && required) {
          process.stderr.write("This field is required. Please enter a value.\n");
          askQuestion();
          return;
        }

        rl.close();
        resolve(trimmed);
      });
    };

    askQuestion();
  });
}

/**
 * Prompts the user for numeric input.
 *
 * Re-prompts on non-numeric input.
 *
 * @param message - The prompt message to display
 * @param options - Optional configuration
 * @param options.defaultValue - Default value if user presses Enter without input
 * @param options.min - Minimum allowed value
 * @param options.max - Maximum allowed value
 * @param options.integer - If true, only accepts integers (default: false)
 * @returns The user's numeric input
 *
 * @example
 * const rating = await inputNumber('Minimum rating (0-5):', { min: 0, max: 5 });
 */
export async function inputNumber(
  message: string,
  options?: { defaultValue?: number; min?: number; max?: number; integer?: boolean },
): Promise<number> {
  const rl = createPromptInterface();
  const { defaultValue, min, max, integer = false } = options ?? {};

  const defaultHint = defaultValue !== undefined ? ` [${defaultValue}]` : "";
  const prompt = `${message}${defaultHint} `;

  return new Promise<number>((resolve) => {
    const askQuestion = (): void => {
      rl.question(prompt, (answer) => {
        const trimmed = answer.trim();

        if (trimmed === "" && defaultValue !== undefined) {
          rl.close();
          resolve(defaultValue);
          return;
        }

        const num = parseFloat(trimmed);

        if (isNaN(num)) {
          process.stderr.write("Please enter a valid number.\n");
          askQuestion();
          return;
        }

        if (integer && !Number.isInteger(num)) {
          process.stderr.write("Please enter a whole number.\n");
          askQuestion();
          return;
        }

        if (min !== undefined && num < min) {
          process.stderr.write(`Value must be at least ${min}.\n`);
          askQuestion();
          return;
        }

        if (max !== undefined && num > max) {
          process.stderr.write(`Value must be at most ${max}.\n`);
          askQuestion();
          return;
        }

        rl.close();
        resolve(num);
      });
    };

    askQuestion();
  });
}

/**
 * Checks if the current environment supports interactive prompts.
 *
 * Returns false if stdin is not a TTY (e.g., piped input, CI environment).
 *
 * @returns true if interactive prompts are supported
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}
