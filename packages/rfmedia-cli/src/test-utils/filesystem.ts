import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates an isolated temporary directory for a test suite.
 */
export async function createTempTestDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Removes a temporary directory created for tests.
 */
export async function cleanupTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Creates a dummy file for filesystem-oriented tests.
 */
export async function createTestFile(
  filePath: string,
  content: string = "test audio data",
): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}
