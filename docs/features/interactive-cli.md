# Interactive CLI Workflows

Interactive mode provides terminal-based selectors for choosing sources, albums, tracks, or delete candidates. These flows are used by `rfmedia` commands when `--interactive` is enabled.

## Prerequisites

- Interactive mode requires a TTY terminal.
- Interactive mode cannot be used with `--json` output.

## Supported Commands

### Copy

```bash
rfmedia copy --paths=sources.yml --interactive
rfmedia copy /music/Artist1 /music/Artist2 /dest --range=001-003 --interactive
```

Interactive copy lets you:

- Select sources and albums/tracks to include.
- Filter within the selector using type-ahead search.

### Delete

```bash
rfmedia delete --paths=sources.yml --interactive
```

Interactive delete lets you:

- Select suffixed copies to remove.
- Filter by artist or suffix in the selector.

### Queue (Add)

```bash
rfmedia queue add copy --paths sources.yml --interactive
rfmedia queue add delete --paths sources.yml --interactive
```

Queue interactive mode filters sources at queue creation time.

## Selection Behavior

- **Track selection** uses album grouping for clarity.
- **Delete selection** groups items by artist and displays suffixes.
- **Filter input** only accepts filename-safe characters.

## Related Documentation

- [rfmedia CLI README](../../packages/rfmedia-cli/README.md)
- [rfmedia Commands](../api/rfmedia-commands.md)
- [Data Flow Patterns](../architecture/data-flow.md)
