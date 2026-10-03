# Vitest Testing Troubleshooting Guide

This guide documents common testing issues in the rfmedia-cli project and their solutions, with particular focus on mock lifecycle problems that can cause intermittent test failures.

## Table of Contents

- [Mock Lifecycle Issues](#mock-lifecycle-issues)
  - [Symptoms](#symptoms)
  - [Root Cause: resetAllMocks vs clearAllMocks](#root-cause-resetallmocks-vs-clearallmocks)
  - [Solution](#solution)
- [Debugging Mock Configuration](#debugging-mock-configuration)
  - [Verifying Mock Setup](#verifying-mock-setup)
  - [Checking Mock Call History](#checking-mock-call-history)
  - [Mock Return Value Debugging](#mock-return-value-debugging)
- [Common Mock Configuration Mistakes](#common-mock-configuration-mistakes)
  - [Mistake 1: Using resetAllMocks Instead of clearAllMocks](#mistake-1-using-resetallmocks-instead-of-clearallmocks)
  - [Mistake 2: Mock Hoisting Issues](#mistake-2-mock-hoisting-issues)
  - [Mistake 3: Mock Implementation Not Restored After Test](#mistake-3-mock-implementation-not-restored-after-test)
  - [Mistake 4: Async Mock Timing Issues](#mistake-4-async-mock-timing-issues)
  - [Mistake 5: Mock Reference Loss](#mistake-5-mock-reference-loss)
- [Best Practices](#best-practices)
- [Shared Test Utilities](#shared-test-utilities)
- [Allowed Mock Reset Exceptions](#allowed-mock-reset-exceptions)
- [Debugging Checklist](#debugging-checklist)

## Mock Lifecycle Issues

### Symptoms

Mock lifecycle problems typically manifest as:

1. **Mocks returning `undefined` unexpectedly** - Functions that should return mocked values instead return `undefined`
2. **Tests passing individually but failing when run in suite** - Tests work in isolation with `it.only()` but fail when the full suite runs
3. **Intermittent failures** - Tests pass sometimes and fail other times without code changes
4. **Mock call counts incorrect** - `toHaveBeenCalled()` assertions fail despite mocks being set up
5. **Sequential tests affecting each other** - Earlier tests in a suite affect the behavior of later tests

### Root Cause: resetAllMocks vs clearAllMocks

The most common cause of mock lifecycle issues is using `vi.resetAllMocks()` instead of `vi.clearAllMocks()`.

**Key difference:**

| Method               | Behavior                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| `vi.clearAllMocks()` | Clears call history only. Mock implementations remain intact.                          |
| `vi.resetAllMocks()` | Clears call history AND resets implementations to empty stubs that return `undefined`. |

**Example of the problem:**

```typescript
// Test setup with vi.hoisted
const mocks = vi.hoisted(() => ({
  findAudioFiles: vi.fn().mockResolvedValue(["/path/to/file.flac"]),
}));

vi.mock("../lib/audio.js", () => ({
  findAudioFiles: mocks.findAudioFiles,
}));

describe("MyFeature", () => {
  afterEach(() => {
    vi.resetAllMocks(); // BUG: This resets mockResolvedValue to undefined!
  });

  it("first test passes", async () => {
    // Works - mock still has its implementation
    const files = await mocks.findAudioFiles("/source");
    expect(files).toEqual(["/path/to/file.flac"]);
  });

  it("second test FAILS", async () => {
    // FAILS - resetAllMocks cleared the implementation!
    const files = await mocks.findAudioFiles("/source");
    expect(files).toEqual(["/path/to/file.flac"]); // files is undefined
  });
});
```

### Solution

Use `vi.clearAllMocks()` instead of `vi.resetAllMocks()` when you want to clear call history between tests while preserving mock implementations.

```typescript
describe("MyFeature", () => {
  beforeEach(() => {
    vi.clearAllMocks(); // Clears call counts but keeps implementations

    // Re-set up any mock implementations that need specific values per test
    mocks.getFileSize.mockResolvedValue(10485760);
    mocks.copyOrLink.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks(); // Safe - only clears history
  });
});
```

## Debugging Mock Configuration

### Verifying Mock Setup

Add debug logging to verify mocks are properly configured:

```typescript
it("should process files correctly", async () => {
  const trackPath = "/source/Album/track1.flac";

  // Set up mock
  mockFindAudioFiles.mockResolvedValue([trackPath]);

  // Verify mock is working before running test
  console.log("Mock setup - trackPath:", trackPath);
  console.log("Mock setup - findAudioFiles will return:", [trackPath]);

  // Test the mock directly
  const testResult = await mockFindAudioFiles("/source");
  console.log("Direct mock call returned:", testResult);
  expect(testResult).toEqual([trackPath]); // Verify mock works

  // Now run the actual test...
});
```

### Checking Mock Call History

Inspect how mocks are being called during test execution:

```typescript
it("should call dependencies correctly", async () => {
  // Run the function under test
  const result = await executeFilterCopy(sourceDir, destDir, options);

  // Debug: Check mock call details
  console.log("findAudioFiles called", mockFindAudioFiles.mock.calls.length, "times");
  console.log("findAudioFiles calls:", mockFindAudioFiles.mock.calls);
  console.log("findAudioFiles results:", mockFindAudioFiles.mock.results);

  // Check if mock was even called
  expect(mockFindAudioFiles, "findAudioFiles should be called").toHaveBeenCalled();
});
```

### Mock Return Value Debugging

Verify what mocks are actually returning:

```typescript
it("should handle metadata correctly", async () => {
  // Set up mock with specific return value
  mockReadExtendedMetadata.mockResolvedValue({
    rating: { value: 0.8, source: "Vorbis" },
    format: { duration: 180, bitrate: 320000, codec: "FLAC" },
    common: { genre: ["Rock"], year: 2020 },
  });

  // Verify mock reference is correct
  console.log(
    "mockReadExtendedMetadata === mocks.readExtendedMetadata:",
    mockReadExtendedMetadata === mocks.readExtendedMetadata,
  );

  // Test mock directly
  const metadata = await mockReadExtendedMetadata("/path/to/file.flac");
  console.log("Mock returned:", metadata);
  expect(metadata).not.toBeNull();
  expect(metadata?.rating?.value).toBe(0.8);
});
```

## Common Mock Configuration Mistakes

### Mistake 1: Using resetAllMocks Instead of clearAllMocks

**Problem:** Mock implementations are cleared between tests.

```typescript
// BAD
afterEach(() => {
  vi.resetAllMocks(); // Clears implementations!
});

// GOOD
afterEach(() => {
  vi.clearAllMocks(); // Only clears call history
});
```

### Mistake 2: Mock Hoisting Issues

**Problem:** Mocks are defined in a way that prevents proper hoisting.

```typescript
// BAD - Mocks defined after vi.mock may not work
vi.mock("../lib/audio.js", () => ({
  findAudioFiles: vi.fn(), // This creates a new mock each time
}));

// GOOD - Use vi.hoisted for proper hoisting
const mocks = vi.hoisted(() => ({
  findAudioFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/audio.js", () => ({
  findAudioFiles: mocks.findAudioFiles,
}));
```

### Mistake 3: Mock Implementation Not Restored After Test

**Problem:** Test-specific mock implementations leak to other tests.

```typescript
// BAD - Implementation persists
it("test with custom mock", async () => {
  mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });
  // Test runs...
  // Mock implementation persists to next test!
});

// GOOD - Clear in beforeEach and set up per-test
beforeEach(() => {
  vi.clearAllMocks();
  // Set default implementations
  mockReadRating.mockResolvedValue(null);
});

it("test with custom mock", async () => {
  // Override for this specific test
  mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });
  // Test runs...
});
```

### Mistake 4: Async Mock Timing Issues

**Problem:** Mock setup races with test execution.

```typescript
// BAD - Async setup without await
beforeEach(() => {
  someAsyncSetup(); // Not awaited!
  vi.clearAllMocks();
});

// GOOD - Properly await async setup
beforeEach(async () => {
  await someAsyncSetup();
  vi.clearAllMocks();
});
```

### Mistake 5: Mock Reference Loss

**Problem:** Test uses a different reference than the module mock.

```typescript
// BAD - Destructuring creates a copy
import { findAudioFiles } from "../lib/audio.js";
// findAudioFiles is now a copy, not the mock!

// GOOD - Keep reference to the mock
const mockFindAudioFiles = mocks.findAudioFiles;

// Or use the mock directly from the hoisted object
mocks.findAudioFiles.mockResolvedValue(["/path/to/file.flac"]);
```

## Best Practices

### 1. Use vi.hoisted for Mock Definitions

Always define mocks using `vi.hoisted()` to ensure proper hoisting:

```typescript
const mocks = vi.hoisted(() => ({
  findAudioFiles: vi.fn().mockResolvedValue([]),
  readRating: vi.fn().mockResolvedValue(null),
  copyOrLink: vi.fn().mockResolvedValue(undefined),
}));
```

### 2. Set Up Default Implementations in beforeEach

Establish consistent baseline mock behavior before each test:

```typescript
beforeEach(async () => {
  // Create test directories
  tempDir = await mkdtemp(join(tmpdir(), "test-"));

  // Clear call history
  vi.clearAllMocks();

  // Set up default mock implementations
  mocks.getFileSize.mockResolvedValue(10485760);
  mocks.copyOrLink.mockResolvedValue(undefined);
  mocks.readRating.mockResolvedValue(null);
});
```

### 3. Clean Up in afterEach

Always clean up test resources and clear mocks:

```typescript
afterEach(async () => {
  // Clean up filesystem
  await rm(tempDir, { recursive: true, force: true });

  // Clear mock call history
  vi.clearAllMocks();
});
```

### 4. Use Descriptive Mock Assertions

Include context in assertions for better error messages:

```typescript
expect(mockFindAudioFiles, "findAudioFiles should be called").toHaveBeenCalled();
expect(mockReadMetadata, "metadata should be read for each file").toHaveBeenCalledTimes(3);
```

### 5. Test Mocks Directly When Debugging

Before testing the full integration, verify mocks work in isolation:

```typescript
it("should use correct metadata", async () => {
  const testPath = "/source/track.flac";

  // Verify mock is set up correctly
  const directResult = await mockReadMetadata(testPath);
  expect(directResult).not.toBeNull();
  expect(directResult?.rating?.value).toBe(0.8);

  // Clear call history from verification
  mockReadMetadata.mockClear();

  // Now run the actual test
  const result = await executeFilterCopy(sourceDir, destDir, options);
  // ... assertions
});
```

### 6. Use mockResolvedValueOnce for Sequential Returns

When mocks need to return different values for sequential calls:

```typescript
mockReadRating
  .mockResolvedValueOnce({ value: 0.9, source: "Vorbis" }) // First call
  .mockResolvedValueOnce({ value: 0.5, source: "Vorbis" }) // Second call
  .mockResolvedValueOnce({ value: 0.8, source: "Vorbis" }); // Third call
```

## Shared Test Utilities

Reusable helpers live in `packages/rfmedia-cli/src/test-utils/`:

| Helper                                  | Module              | Use when                                                         |
| --------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| `clearMocksPreservingImplementations()` | `mock-lifecycle.ts` | Lifecycle cleanup between tests with stable `vi.hoisted()` mocks |
| `createTempTestDir(prefix)`             | `filesystem.ts`     | Creating isolated temp directories                               |
| `cleanupTempDir(path)`                  | `filesystem.ts`     | Removing temp directories in `afterEach()`                       |
| `createTestFile(path, content?)`        | `filesystem.ts`     | Creating dummy files for filesystem tests                        |

Keep domain-specific mock bags and assertions in the test file. Do not move `vi.hoisted()` module mocks into shared utilities unless the helper is used inside `vi.hoisted()` safely.

Reference files:

- `src/actions/copy-filter.test.ts` — canonical `vi.hoisted()` pattern
- `src/lib/integrity.test.ts` — lifecycle fix for module mocks

## Allowed Mock Reset Exceptions

Not every reset API is unsafe. Preserve these intentional patterns:

| API                    | When it is acceptable                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `mockReset()`          | Clearing queued `mockResolvedValueOnce()` responses when `beforeEach` re-establishes defaults |
| `mockRestore()`        | Restoring a spy on a real implementation after a test                                         |
| `vi.restoreAllMocks()` | Restoring multiple spies on real globals in `afterEach()`                                     |

Avoid `vi.resetAllMocks()` in routine lifecycle hooks. It clears implementations created by `vi.hoisted()` and causes order-dependent failures.

Audit command:

```bash
rg "^[[:space:]]*vi\.resetAllMocks\(" packages/rfmedia-cli/src --glob "*.test.ts"
```

## Debugging Checklist

When tests are failing unexpectedly, work through this checklist:

- [ ] **Check mock method:** Are you using `clearAllMocks()` instead of `resetAllMocks()`?
- [ ] **Verify hoisting:** Are mocks defined with `vi.hoisted()`?
- [ ] **Check references:** Are test files using the same mock reference as the vi.mock factory?
- [ ] **Add logging:** Add console.log statements to verify mock setup and call patterns
- [ ] **Test in isolation:** Does the test pass with `it.only()`?
- [ ] **Check test order:** Does changing test order affect which tests fail?
- [ ] **Verify beforeEach:** Is mock setup happening in beforeEach, not at module level?
- [ ] **Check async timing:** Are all async operations properly awaited?
- [ ] **Inspect mock calls:** Use `mock.calls` and `mock.results` to see actual behavior
- [ ] **Clear between tests:** Is call history being cleared between tests?

## Example: Complete Test File Structure

Here is an example of a well-structured test file following all best practices:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 1. Define mocks with vi.hoisted
const mocks = vi.hoisted(() => ({
  findAudioFiles: vi.fn().mockResolvedValue([]),
  readRating: vi.fn().mockResolvedValue(null),
  copyOrLink: vi.fn().mockResolvedValue(undefined),
  getFileSize: vi.fn().mockResolvedValue(10485760),
}));

// 2. Set up module mocks
vi.mock("../lib/audio.js", () => ({
  findAudioFiles: mocks.findAudioFiles,
}));

vi.mock("../lib/ratings.js", () => ({
  readRating: mocks.readRating,
}));

vi.mock("../lib/filesystem.js", () => ({
  copyOrLink: mocks.copyOrLink,
  getFileSize: mocks.getFileSize,
}));

// 3. Export mock references for tests
const mockFindAudioFiles = mocks.findAudioFiles;
const mockReadRating = mocks.readRating;
const mockCopyOrLink = mocks.copyOrLink;
const mockGetFileSize = mocks.getFileSize;

describe("MyFeature", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;

  // 4. Set up test environment in beforeEach
  beforeEach(async () => {
    // Create temp directories
    tempDir = await mkdtemp(join(tmpdir(), "test-"));
    sourceDir = join(tempDir, "source");
    destDir = join(tempDir, "dest");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(destDir, { recursive: true });

    // Clear call history (NOT implementations!)
    vi.clearAllMocks();

    // Set up default mock implementations
    mockGetFileSize.mockResolvedValue(10485760);
    mockCopyOrLink.mockResolvedValue(undefined);
  });

  // 5. Clean up in afterEach
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("should process files correctly", async () => {
    // Arrange: Set up test-specific mock behavior
    const trackPath = join(sourceDir, "track.flac");
    await writeFile(trackPath, "dummy content");

    mockFindAudioFiles.mockResolvedValue([trackPath]);
    mockReadRating.mockResolvedValue({ value: 0.8, source: "Vorbis" });

    // Act: Run the function under test
    const result = await executeFeature(sourceDir, destDir);

    // Assert: Verify results and mock calls
    expect(result.created).toBe(1);
    expect(mockFindAudioFiles, "should discover audio files").toHaveBeenCalledWith(sourceDir);
    expect(mockReadRating, "should read rating").toHaveBeenCalledWith(trackPath);
  });
});
```

## Related Documentation

- [Vitest Mocking Documentation](https://vitest.dev/guide/mocking.html)
- [Vitest API Reference - vi Methods](https://vitest.dev/api/vi.html)
- [Project CLAUDE.md Testing Section](packages/rfmedia-cli/CLAUDE.md#testing)
