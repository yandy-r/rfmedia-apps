# External Research: Issue 56 Action Tests

## Executive Summary

No new dependency is needed for the requested `verify-album`, `verify-filter`,
`sync`, or `migrate-tracking` tests. The package already has Vitest 4.0.17,
`@vitest/coverage-v8` 4.0.17, Node 22, and `fast-glob` 3.3.3. Node's built-in
temporary-directory and filesystem APIs are sufficient for realistic fixtures,
while Vitest's module mocks cover deterministic failures and destructive
operations.

The strongest pattern is a hybrid:

- Use real, per-test temporary directories for observable path and file behavior.
- Mock project boundary modules for copying, hashing, database access, prompts,
  and logging.
- Partially mock `node:fs/promises` only where an exact `stat`, `readFile`,
  `readdir`, or `unlink` failure is the contract under test.
- Drive the exported action rather than attempting to mock its same-file private
  helpers.

This keeps the additions focused on critical behavior: missing files, size
mismatches, extra files, conflict decisions, persistence ordering/failure, and
migration discovery/deletion. It does not justify adding `memfs`, `mock-fs`, or
another test SDK.

**Confidence**: High. The recommendation is supported by the repository's pinned
toolchain, existing test style, and current official Vitest and Node documentation.

## Primary APIs and Documentation URLs

| Source                                                                                       | Version/date                                                | Relevant contract                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Vitest `vi` API](https://v4.vitest.dev/api/vi)                                              | Vitest 4 docs; accessed 2026-08-07                          | `vi.mock` is hoisted; `vi.hoisted` supplies factory-visible state; `importOriginal` enables partial mocks; `vi.clearAllMocks` clears history but retains implementations. |
| [Vitest module-mocking guide](https://v4.vitest.dev/guide/mocking/modules)                   | Vitest 4 docs; accessed 2026-08-07                          | Explains ESM transformation and the same-file-call limitation that makes action-boundary testing preferable.                                                              |
| [Vitest mock-function API](https://v4.vitest.dev/api/mock)                                   | Vitest 4 docs; accessed 2026-08-07                          | Defines `mockResolvedValueOnce`, `mockRejectedValueOnce`, `mockClear`, and `mockReset` behavior.                                                                          |
| [Vitest 4.0.17 release](https://github.com/vitest-dev/vitest/releases/tag/v4.0.17)           | Published 2026-01-12                                        | Confirms the exact lockfile release used by this worktree.                                                                                                                |
| [Node 22.22.2 filesystem API](https://nodejs.org/download/release/v22.22.2/docs/api/fs.html) | Documentation last modified 2026-03-24; accessed 2026-08-07 | `fsPromises.mkdtemp`, `readdir({ withFileTypes: true })`, `readFile`, `unlink`, and `rm({ recursive: true, force: true })`.                                               |
| [`fast-glob` README](https://github.com/mrmlnc/fast-glob)                                    | Accessed 2026-08-07                                         | `cwd` defaults to `process.cwd()`; `absolute: true` returns absolute matches; a custom filesystem adapter is supported if production code explicitly supplies one.        |
| [`fast-glob` 3.3.3 release](https://github.com/mrmlnc/fast-glob/releases/tag/3.3.3)          | Published 2025-01-05                                        | Confirms the exact lockfile release used by `migrate-tracking`.                                                                                                           |

**Confidence**: High. These are version-specific vendor documentation or primary
project repositories, not secondary tutorials.

## Libraries and SDKs

### Existing test/runtime stack

- **Vitest 4.0.17**: installed through the current lockfile; the package declares
  `^4.0.0`. The test environment is `node`, globals are enabled, and tests match
  `src/**/*.test.ts` and `src/**/*.spec.ts`.
- **`@vitest/coverage-v8` 4.0.17**: already configured with the V8 provider. No
  coverage dependency change is required.
- **Node 22.22.2**: pinned in `.mise.toml`; the root requires Node 22.x and the CLI
  package requires Node 22 or later.
- **`fast-glob` 3.3.3**: already used by `migrate-tracking` to find
  `*.completed.*.txt` and `*.failed.*.txt` below a `cwd`, returning absolute paths.
- **`node:fs/promises`, `node:os`, and `node:path`**: sufficient for isolated
  fixture trees and cleanup.

### Dependency decision

Do not add `memfs`, `mock-fs`, `unionfs`, or a second mocking library. They would
introduce a parallel filesystem model without removing the need to mock project
boundaries such as the database, prompts, inventory, conflict resolver, and
history migration. The built-in filesystem gives higher-fidelity path behavior,
and Vitest already provides deterministic module and function mocking.

**Confidence**: High. Every required capability is present in the checked-in
toolchain.

## Integration Patterns

### 1. Hoisted ESM boundary mocks

Vitest hoists `vi.mock` ahead of imports. State referenced by a mock factory must
therefore be created with `vi.hoisted`. For TypeScript, the module-promise form
provides type checking, while the existing tests' string-path form is also valid.
Default-export modules such as `fast-glob` must expose a `default` key.

```ts
const mocks = vi.hoisted(() => ({
  glob: vi.fn<
    (...args: Parameters<typeof import("fast-glob").default>) => ReturnType<typeof import("fast-glob").default>
  >(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("fast-glob", () => ({ default: mocks.glob }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: mocks.readFile,
    readdir: mocks.readdir,
    unlink: mocks.unlink,
  };
});
```

This is appropriate for `migrate-tracking` discovery and deletion cases because
it avoids real deletion and can precisely model malformed history, read failure,
and partial unlink failure.

**Confidence**: High. This follows the Vitest 4 API and the partial built-in-module
mock already used by the verify suites.

### 2. Real temporary directories for path behavior

Use Node's unique temporary directories when path construction, directory
enumeration, or cleanup is part of the observable behavior.

```ts
let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "rfmedia-migrate-"));
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});
```

For tracking discovery, mock or spy on the boundary that supplies `cwd`; avoid a
suite-wide `process.chdir`, which mutates shared process state. For history
discovery, pass `historyPath: fixtureRoot`. Retain `rm` from the real
`node:fs/promises` module when partially mocking other exports.

**Confidence**: High for the Node APIs; Medium for preferring a `cwd` spy over
`process.chdir`, which is a test-isolation recommendation rather than an API
requirement.

### 3. Scenario-specific behavior, not a general fake filesystem

Use the narrowest seam for each critical contract:

| Action                           | Critical seam                                                                     | Representative assertion                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-album` / `verify-filter` | Project filesystem wrapper, tier verifier, conflict resolver, partial `stat` mock | Missing remains missing; size mismatch remains unresolved on `skip`; authorized overwrite is staged and reverified; extras are kept or removed according to strategy.                   |
| `sync`                           | Inventory diff, copy/convert, hash, inventory append                              | New/updated/removed inputs produce correct counts; a materialization/hash/persistence failure is not counted as copied; dry-run performs no mutation.                                   |
| `migrate-tracking`               | `fast-glob`, `readFile`, `readdir`, `unlink`, database/history boundaries         | Completed/failed pairs group by hash; comments and blank lines do not count; malformed history is skipped with a warning; deletion continues after one `unlink` failure and reports it. |

Use `mockResolvedValueOnce` / `mockRejectedValueOnce` for ordered source and
destination stats or one failing deletion. Re-establish default implementations
in `beforeEach`; `vi.clearAllMocks()` clears call history but does not reset those
implementations.

**Confidence**: High. The APIs are documented and the seams correspond directly
to current action imports.

### 4. Exercise the exported action boundary

Vitest explicitly documents that an exported function cannot be mocked to alter
a call made to it from another function in the same module. The private
`migrateTrackingFiles`, `discoverLegacyTrackingFiles`,
`discoverLegacyHistoryFiles`, and `deleteLegacyFiles` functions should therefore
be covered through `executeMigrate`, with their imported dependencies mocked.

This also prevents tests from binding to helper implementation details. Assertions
should target the returned `MigrateResult`, database/history calls, deletion calls,
and user-visible warnings.

**Confidence**: High. This is a documented Vitest limitation and a direct fit for
the current module structure.

## Constraints and Gotchas

- `vi.mock` factories run once and are cached. Per-test changes belong on the
  hoisted mock functions, not in new factories declared inside individual tests.
- `vi.clearAllMocks()` clears call records but preserves implementations;
  `vi.resetAllMocks()` also resets implementations; `vi.restoreAllMocks()` only
  restores spies made with `vi.spyOn`. Cleanup should match the mechanism used.
- `vi.resetModules()` clears the module cache but does not clear the mock registry.
  It is unnecessary unless a test truly needs module initialization to rerun.
- A partial `node:fs/promises` mock must spread the original module so
  `mkdtemp`, `mkdir`, and `rm` remain usable by the fixture harness.
- A `fast-glob` mock must model its default export. For an integration fixture,
  remember that production requests `cwd`, `absolute: true`, and `dot: false`.
- `readdir({ withFileTypes: true })` yields `Dirent` objects, not strings. A mock
  needs at least `name` and `isFile()` for the current history scanner.
- `rm({ recursive: true, force: true })` is suitable for test cleanup; production
  deletion uses `unlink`, whose rejected error should preserve an optional
  `NodeJS.ErrnoException.code` in the result.
- The current tracking migration branch counts grouped entries but contains a
  TODO instead of persisting them. Tests should prove the present contract or the
  issue should explicitly authorize completing that implementation; a test must
  not imply database migration already occurs.
- The current non-dry-run history path discovers files from `options.historyPath`
  but calls `migrateLegacyHistory(db)` without forwarding that path. Confirm the
  intended contract before encoding a custom-path success test.
- Avoid duplicating the extensive verify conflict matrix already present. Add only
  missing contract cases (especially missing source/destination behavior or a
  demonstrated conflict regression) and keep common fixture builders shared
  within each test file.

**Confidence**: High for the tool/API constraints; Medium for the two migration
contract cautions because they are implementation observations requiring product
intent confirmation.

## Representative Examples

### Partial deletion failure

```ts
mocks.unlink
  .mockResolvedValueOnce(undefined)
  .mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));

const result = await executeMigrate({
  deleteOld: true,
  force: true,
  trackingOnly: true,
  historyOnly: false,
  dryRun: false,
});

expect(result.filesDeleted).toBe(1);
expect(result.errors).toEqual([expect.objectContaining({ code: "EACCES", message: "permission denied" })]);
expect(mocks.unlink).toHaveBeenCalledTimes(2);
```

### Size mismatch ordering

```ts
mockStat.mockResolvedValueOnce({ size: 10_000 }).mockResolvedValueOnce({ size: 5_000 });

await executeVerify(/* conflictStrategy: "skip", verifySize: true */);

expect(resolveConflictsByStrategy).toHaveBeenCalledWith(
  expect.arrayContaining([
    expect.objectContaining({
      conflictType: expect.objectContaining({
        type: "size-mismatch",
        expected: 10_000,
        actual: 5_000,
      }),
    }),
  ]),
  "skip",
  expect.anything(),
);
expect(copyOrLink).not.toHaveBeenCalled();
```

These examples are patterns, not proposed verbatim tests; exact argument shapes
should follow the action's current types and local helpers.

## Open Questions

1. Does issue 56 include completing the tracking database migration TODO, or only
   characterizing the action's current discovery/count/delete behavior?
2. Should `--history-path` control both discovery and `migrateLegacyHistory`, or
   discovery only? The current call boundary does not pass the custom path.
3. Which missing/extra-file cases remain unproved after the existing verify suites
   are reconciled with the issue acceptance criteria? The present suites already
   cover many size mismatch, extra-file, strategy, dry-run, and staged-repair cases.
4. For `sync`, are removed and downgraded inventory entries in scope, or is the
   intended critical addition limited to materialization and persistence failures?
5. Should filesystem errors be asserted through returned structured failures,
   warning logs, or both? Prefer the structured result as the stable contract and
   log assertions only where user notification itself is required.

**Confidence**: Medium. These require issue-owner intent or code changes beyond
external API research.
