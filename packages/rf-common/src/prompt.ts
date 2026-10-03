/**
 * User prompt utilities for rfmedia CLI tools.
 *
 * Provides interactive confirmation prompts using Node.js readline.
 */

import { createInterface } from "node:readline";

import { PromptInterruptedError } from "./errors.js";

/**
 * Check if a keypress is an Enter key (CR, LF, or CR+LF).
 */
function isEnterKey(key: string): boolean {
  return key === "\r" || key === "\n" || key === "\r\n" || key.includes("\r") || key.includes("\n");
}

/**
 * Drain any buffered stdin data.
 * This is used to clear stale input (like Enter from Ink UI) before prompting.
 */
async function drainStdin(): Promise<void> {
  if (!process.stdin.isTTY) return;

  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    // Discard any data that arrives
    const discardHandler = (): void => {
      // Intentionally discard
    };
    process.stdin.on("data", discardHandler);

    // Wait for buffered data to flow through, then clean up
    setTimeout(() => {
      process.stdin.removeListener("data", discardHandler);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      resolve();
    }, 200);
  });
}

/**
 * Read a single keypress in raw mode.
 * Returns the key character or null if not a TTY or if stdin closes.
 */
async function readKeypress(): Promise<string | null> {
  if (!process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    // Ensure stdin keeps the process alive while we wait.
    // This is critical because Ink calls unref() during cleanup,
    // which would cause the process to exit before we can read input.
    process.stdin.ref();

    const cleanup = (): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("close", onClose);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
    };

    const onData = (data: Buffer): void => {
      cleanup();
      resolve(data.toString());
    };

    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };

    const onClose = (): void => {
      cleanup();
      resolve(null);
    };

    process.stdin.once("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("close", onClose);
  });
}

/**
 * Prompts the user for a yes/no confirmation using raw keypress detection.
 *
 * Uses raw mode to read a single keypress, avoiding issues with
 * buffered input from previous Ink prompts.
 *
 * Accepts: y/Y (confirm), n/N/Enter/Escape (reject), Ctrl+C (exit)
 *
 * @param message - The prompt message to display
 * @returns true if user confirms, false otherwise
 */
export async function confirm(message: string): Promise<boolean> {
  // Non-TTY: default to false
  if (!process.stdin.isTTY) {
    process.stderr.write(`${message} [y/N] \n`);
    return false;
  }

  // Drain any stale input from previous Ink UI before displaying prompt
  await drainStdin();

  process.stderr.write(`${message} [y/N] `);

  // Track when prompt was displayed for stale input detection.
  // Use a cooling period to discard Enter keypresses that may still arrive
  // due to event loop timing variability after Ink cleanup.
  const promptDisplayTime = Date.now();
  const COOLING_PERIOD_MS = 300;

  while (true) {
    const key = await readKeypress();

    if (key === null) {
      process.stderr.write("\n");
      return false;
    }

    // Ctrl+C - exit
    if (key === "\x03") {
      process.stderr.write("\n");
      throw new PromptInterruptedError();
    }

    // Discard Enter during cooling period (catches any stale input from Ink)
    const elapsed = Date.now() - promptDisplayTime;
    if (isEnterKey(key) && elapsed < COOLING_PERIOD_MS) {
      continue; // Discard and wait for next keypress
    }

    const char = key.toLowerCase();

    // y/Y - confirm
    if (char === "y") {
      process.stderr.write("y\n");
      return true;
    }

    // Everything else (n, N, Enter, Escape, etc.) - reject
    process.stderr.write("n\n");
    return false;
  }
}

/**
 * Prompts the user for a yes/no confirmation, defaulting to Yes.
 *
 * Uses raw mode to read a single keypress, avoiding issues with
 * buffered input from previous Ink prompts.
 *
 * Accepts: y/Y/Enter (confirm), n/N/Escape (reject), Ctrl+C (exit)
 *
 * @param message - The prompt message to display
 * @returns true if user confirms (or presses Enter), false if user rejects
 */
export async function confirmWithDefault(message: string): Promise<boolean> {
  // Non-TTY: default to true
  if (!process.stdin.isTTY) {
    process.stderr.write(`${message} [Y/n] \n`);
    return true;
  }

  // Drain any stale input from previous Ink UI before displaying prompt
  await drainStdin();

  process.stderr.write(`${message} [Y/n] `);

  // Track when prompt was displayed for stale input detection.
  // Use a cooling period to discard Enter keypresses that may still arrive
  // due to event loop timing variability after Ink cleanup.
  const promptDisplayTime = Date.now();
  const COOLING_PERIOD_MS = 300;

  while (true) {
    const key = await readKeypress();

    if (key === null) {
      process.stderr.write("\n");
      return true;
    }

    // Ctrl+C - exit
    if (key === "\x03") {
      process.stderr.write("\n");
      throw new PromptInterruptedError();
    }

    // Discard Enter during cooling period (catches any stale input from Ink)
    const elapsed = Date.now() - promptDisplayTime;
    if (isEnterKey(key) && elapsed < COOLING_PERIOD_MS) {
      continue; // Discard and wait for next keypress
    }

    const char = key.toLowerCase();

    // n/N - reject
    if (char === "n") {
      process.stderr.write("n\n");
      return false;
    }

    // Everything else (y, Y, Enter, etc.) - confirm
    process.stderr.write("y\n");
    return true;
  }
}

/**
 * Prompts the user for text input.
 *
 * @param message - The prompt message to display
 * @param defaultValue - Optional default value if user presses Enter
 * @returns The user's input (or default value)
 */
export async function prompt(message: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const displayMessage =
    defaultValue !== undefined ? `${message} [${defaultValue}] ` : `${message} `;

  return new Promise<string>((resolve) => {
    rl.question(displayMessage, (answer) => {
      rl.close();

      const trimmed = answer.trim();
      if (trimmed === "" && defaultValue !== undefined) {
        resolve(defaultValue);
      } else {
        resolve(trimmed);
      }
    });
  });
}
