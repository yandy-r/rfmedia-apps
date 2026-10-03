# Plex Filters

This document provides comprehensive guidance for using Plex filters in rfmedia-cli. Plex filters enable config-based filtering with nested boolean logic for Plex library queries, allowing complex criteria for selecting tracks, albums, and artists based on ratings, genres, years, and play counts.

## Overview

### What Are Plex Filters?

Plex filters are named, reusable filter definitions stored in your configuration file under the `plexFilters:` section. They enable complex filtering of Plex library content before copying or processing. Key features include:

- **Nested Boolean Logic**: Combine rules with AND (all) or OR (any) at any nesting level
- **Hierarchical Ratings**: Filter by artist, album, or track ratings independently
- **Multiple Field Types**: Filter by genre, year, play count, and text fields
- **Filter Defaults**: Store default library, media type, and result limits with the filter
- **Hybrid Filtering**: Combines server-side query optimization with client-side evaluation

### Filter Architecture and Compatibility

The `plexFilters` configuration remains the public Plex-facing DSL. Internally, rfmedia parses the
same fields, operators, nested groups, library defaults, media types, and limits into a
provider-neutral filter tree. Query and collection actions operate on that generic tree and generic
media entities; they do not encode Plex query parameters themselves.

The private Plex adapter decides which individual rules can be pushed down for the selected media
type and translates only those rules to Plex query keys. Any rule or boolean structure that was not
applied by Plex is evaluated locally by the provider-neutral residual evaluator. This separation
keeps Plex protocol details private without changing filter names, YAML structure, commands, or
result fields. Existing configurations require no migration.

### Benefits Over CLI Options

| Feature              | CLI Options            | Plex Filters                          |
| -------------------- | ---------------------- | ------------------------------------- |
| Rating threshold     | Yes (`--min-rating=4`) | Yes (`artistRating >= 4`)             |
| Multiple criteria    | Implicit AND only      | AND/OR with nesting                   |
| Genre filtering      | Yes (`--genre`)        | Yes (`genre contains "Rock"`)         |
| Year filtering       | Yes (`--year`)         | Yes (`year >= 2020`)                  |
| Year ranges          | Yes (`--min-year`)     | Yes (`minYear >= 2020`)               |
| Play count filtering | Yes (`--min-plays`)    | Yes (`minPlays >= 10`)                |
| Complex logic        | No                     | Yes (nested AND/OR groups)            |
| Reusable definitions | No                     | Yes (named filters in config)         |
| Default settings     | No                     | Yes (library, type, limit per filter) |

### When to Use Plex Filters vs CLI Options

**Use CLI Options When:**

- You need simple, one-time filtering
- A single criterion is sufficient (e.g., just artist rating)
- Quick ad-hoc queries without config setup

**Use Plex Filters When:**

- You need complex multi-criteria filtering
- You want OR logic (e.g., Rock OR Alternative genres)
- You run the same filter criteria repeatedly
- You want to combine multiple rating types
- You need complex nested boolean expressions

## Quick Start

### Creating Your First Plex Filter

1. Open your `.rfmedia.yaml` configuration file (or create one with `rfmedia init`)

2. Add a filter under the `plexFilters` section:

```yaml
# .rfmedia.yaml
plexFilters:
  high-rated-tracks:
    match: all
    library: Music
    type: track
    limit: 100
    rules:
      - type: rule
        field: artistRating
        operator: ">="
        value: 4
```

3. Run a query with the filter:

```bash
rfmedia plex query run --filter high-rated-tracks
```

### Testing a Filter with Debug Output

Preview what the filter matches and see the filtering strategy:

```bash
rfmedia plex query run --filter high-rated-tracks --debug
```

Debug output shows:

- Filter loading and validation
- Server-side conditions extracted for optimization
- Whether client-side filtering is required
- Final result counts after filtering

## Filter Syntax

### YAML Structure

Plex filters use a declarative YAML structure with two main components:

**Top-Level Filter Definition:**

```yaml
plexFilters:
  filter-name:
    match: all # or 'any'
    library: Music # optional default library
    type: track # optional default media type
    limit: 100 # optional default result limit
    rules:
      -  # Rule or group definitions
```

**Leaf Rules (Single Conditions):**

```yaml
- type: rule
  field: artistRating
  operator: ">="
  value: 4
```

**Groups (Nested Boolean Logic):**

```yaml
- type: group
  match: any # OR logic for this group
  rules:
    - type: rule
      field: genre
      operator: contains
      value: Rock
    - type: rule
      field: genre
      operator: contains
      value: Alternative
```

### match: all vs match: any

| Match Type | Logic | Behavior                         |
| ---------- | ----- | -------------------------------- |
| `all`      | AND   | All rules in the group must pass |
| `any`      | OR    | At least one rule must pass      |

**Example - AND Logic:**

```yaml
match: all
rules:
  - type: rule
    field: artistRating
    operator: ">="
    value: 4
  - type: rule
    field: genre
    operator: contains
    value: Rock
```

This matches items that are BOTH rated 4+ stars AND contain "Rock" in the genre.

**Example - OR Logic:**

```yaml
match: any
rules:
  - type: rule
    field: genre
    operator: contains
    value: Rock
  - type: rule
    field: genre
    operator: contains
    value: Alternative
```

This matches items that contain EITHER "Rock" OR "Alternative" in the genre.

### Rule Types

**Leaf Rules** define a single condition with `field`, `operator`, and `value`:

```yaml
type: rule
field: artistRating
operator: ">="
value: 4
```

**Groups** contain nested rules with their own match strategy:

```yaml
type: group
match: any
rules:
  - type: rule
    field: genre
    operator: contains
    value: Rock
  - type: rule
    field: genre
    operator: contains
    value: Alternative
```

## Field Reference

### Available Fields

| Field          | Type   | Description               | Compatible Media Types |
| -------------- | ------ | ------------------------- | ---------------------- |
| `artistRating` | number | Artist star rating (1-5)  | artist, album, track   |
| `albumRating`  | number | Album star rating (1-5)   | album, track           |
| `trackRating`  | number | Track star rating (1-5)   | track                  |
| `genre`        | string | Genre tag                 | all types              |
| `year`         | number | Exact release year        | album, track           |
| `minYear`      | number | Minimum release year      | album, track           |
| `maxYear`      | number | Maximum release year      | album, track           |
| `minPlays`     | number | Minimum play count        | track                  |
| `artist`       | string | Artist name (text search) | all types              |
| `album`        | string | Album name (text search)  | album, track           |
| `title`        | string | Track title (text search) | track                  |

### Rating Field Hierarchy

Rating fields follow a hierarchy based on media type:

- **Track queries**: Can use `artistRating`, `albumRating`, and `trackRating`
- **Album queries**: Can use `artistRating` and `albumRating`
- **Artist queries**: Can use `artistRating` only

Rating values are specified on the existing 1-5 star scale (matching the Plex UI). rfmedia
normalizes ratings to `0..1` while actions and residual filters operate on generic media entities.
Only the private Plex adapter converts supported pushdown rules to Plex's native `0..10` scale.
Plex-facing JSON and other compatibility output continue to use their established fields and
native values.

### Operator Reference

| Operator       | Description                             | Compatible Fields                                                        |
| -------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| `>=`           | Greater than or equal                   | artistRating, albumRating, trackRating, year, minYear, maxYear, minPlays |
| `<=`           | Less than or equal                      | artistRating, albumRating, trackRating, year, minYear, maxYear, minPlays |
| `==`           | Exact match (case-insensitive for text) | All fields                                                               |
| `!=`           | Not equal (case-insensitive for text)   | All fields                                                               |
| `contains`     | Substring match (case-insensitive)      | genre, style, mood, artist, album, title                                 |
| `not_contains` | Substring exclusion (case-insensitive)  | genre, style, mood, artist, album, title                                 |

### Field/Operator Compatibility

| Field Type                                                         | Supported Operators                    |
| ------------------------------------------------------------------ | -------------------------------------- |
| Rating fields (`artistRating`, `albumRating`, `trackRating`)       | `>=`, `<=`, `==`, `!=`                 |
| Year fields (`year`, `minYear`, `maxYear`)                         | `>=`, `<=`, `==`, `!=`                 |
| Play count (`minPlays`)                                            | `>=`, `<=`, `==`, `!=`                 |
| Text fields (`genre`, `style`, `mood`, `artist`, `album`, `title`) | `contains`, `not_contains`, `==`, `!=` |

## Negative Operators (Exclusion Filters)

The `!=` and `not_contains` operators enable powerful exclusion-based filtering, allowing you to filter OUT unwanted content rather than filtering FOR specific content.

### Server-Side Support

The private Plex adapter pushes a negative rule only when Plex supports that exact field, operator,
and media type. Unsupported combinations remain part of the local residual filter, so correctness
does not depend on a pushdown optimization. Per the [Plexopedia API documentation](https://www.plexopedia.com/plex-media-server/api/filter/), Plex natively supports:

| Operator       | Field Type | Plex API Behavior      | URL Encoding    |
| -------------- | ---------- | ---------------------- | --------------- |
| `!=`           | numeric    | Not equals             | `field!=value`  |
| `!=`           | string     | Does not equal exactly | `field!==value` |
| `not_contains` | string     | Does not contain       | `field!=value`  |

This means exclusion filters reduce data transfer by filtering at the Plex server instead of fetching excess data and filtering locally.

### Operator Semantics

**`!=` (Not Equal)**

- For **numeric fields** (ratings, year, plays): Excludes items where the value equals the specified number
- For **text fields** (genre, artist, etc.): Excludes items where the field exactly matches the value (case-insensitive)

**`not_contains` (Does Not Contain)**

- For **text fields only**: Excludes items where the field contains the specified substring (case-insensitive)
- More flexible than `!=` for partial matching exclusions

### When to Use Each Operator

| Use Case                           | Operator       | Example                                                      |
| ---------------------------------- | -------------- | ------------------------------------------------------------ |
| Exclude exact genre match          | `!=`           | `genre != "Country"` (excludes "Country")                    |
| Exclude genre containing substring | `not_contains` | `genre not_contains "Country"` (excludes "Country Rock" too) |
| Exclude unrated content            | `!=`           | `artistRating != 0`                                          |
| Exclude specific year              | `!=`           | `year != 2020`                                               |
| Exclude compilation albums         | `not_contains` | `album not_contains "Greatest Hits"`                         |
| Exclude tribute bands              | `not_contains` | `artist not_contains "Tribute"`                              |

### Performance Benefits

Server-side negative filtering provides significant performance improvements:

```
Before (client-side):
1. Fetch all tracks from Plex (e.g., 10,000 items)
2. Transfer all data over network
3. Filter out unwanted items locally
4. Return filtered results (e.g., 8,000 items)

After (server-side):
1. Send query with exclusion filter to Plex
2. Plex filters at source
3. Transfer only matching items (e.g., 8,000 items)
4. Return results directly
```

This is especially beneficial for large libraries where exclusion filters can eliminate significant portions of the dataset.

## Examples by Use Case

### High-Rated Tracks Filter

Select tracks where the artist is rated 4+ stars:

```yaml
plexFilters:
  high-rated-tracks:
    match: all
    library: Music
    type: track
    rules:
      - type: rule
        field: artistRating
        operator: ">="
        value: 4
```

### Genre-Based Filter

Select tracks from Rock or Alternative genres:

```yaml
plexFilters:
  rock-collection:
    match: any
    library: Music
    type: track
    rules:
      - type: rule
        field: genre
        operator: contains
        value: Rock
      - type: rule
        field: genre
        operator: contains
        value: Alternative
```

### Multi-Rating Filter

Select tracks where both artist AND album are rated 3+ stars:

```yaml
plexFilters:
  quality-tracks:
    match: all
    library: Music
    type: track
    rules:
      - type: rule
        field: artistRating
        operator: ">="
        value: 3
      - type: rule
        field: albumRating
        operator: ">="
        value: 3
```

### Year Range Filter

Select albums from the 2010s:

```yaml
plexFilters:
  2010s-albums:
    match: all
    library: Music
    type: album
    rules:
      - type: rule
        field: minYear
        operator: ">="
        value: 2010
      - type: rule
        field: maxYear
        operator: "<="
        value: 2019
```

### Popular Tracks Filter

Select frequently played tracks:

```yaml
plexFilters:
  most-played:
    match: all
    library: Music
    type: track
    limit: 50
    rules:
      - type: rule
        field: minPlays
        operator: ">="
        value: 10
```

### Exclusion Filters

Exclude specific genres or content using negative operators:

```yaml
# Exclude specific genres
plexFilters:
  exclude-country:
    match: all
    library: Music
    type: track
    rules:
      - type: rule
        field: genre
        operator: not_contains
        value: Country
```

```yaml
# High-rated non-compilation albums
plexFilters:
  originals-only:
    match: all
    library: Music
    type: track
    rules:
      - type: rule
        field: artistRating
        operator: ">="
        value: 4
      - type: rule
        field: album
        operator: not_contains
        value: "Greatest Hits"
      - type: rule
        field: album
        operator: "!="
        value: "Compilation"
```

### Complex Nested Logic Example

High-rated modern Rock or classic Pop:

```yaml
plexFilters:
  curated-collection:
    match: all # Outer AND
    library: Music
    type: track
    rules:
      - type: rule
        field: artistRating
        operator: ">="
        value: 3
      - type: group
        match: any # Middle OR
        rules:
          - type: group
            match: all # Inner AND: Modern Rock
            rules:
              - type: rule
                field: genre
                operator: contains
                value: Rock
              - type: rule
                field: minYear
                operator: ">="
                value: 2000
          - type: group
            match: all # Inner AND: Classic Pop
            rules:
              - type: rule
                field: genre
                operator: contains
                value: Pop
              - type: rule
                field: maxYear
                operator: "<="
                value: 1999
```

This matches: rated 3+ AND (Modern Rock from 2000+ OR Classic Pop from before 2000).

### Combining with Plex Copy Command

Use filters with the `plex copy` command to copy matching tracks:

```bash
# Copy high-rated tracks to local folder
rfmedia plex query run --filter high-rated-tracks --output /dest/folder

# Or use plex copy directly with query results
rfmedia plex copy --filter high-rated-tracks /dest/folder
```

## Hybrid Filtering Strategy

### Server-Side vs Client-Side Filtering

Plex filters use a hybrid approach to optimize requests while preserving the full generic boolean
expression. The provider-neutral planner identifies safe candidates; the private Plex adapter owns
the decision and encoding for the selected media type.

**Server-Side Filtering (Optimized):**

- Considered when the top-level `match` is `all` (AND logic)
- Only rules supported by the private Plex adapter are pushed to the server
- Reduces data transferred from Plex server
- Support depends on the field, operator, and queried media type

**Client-Side Filtering (Full Logic):**

- Applied after receiving server results
- Supports arbitrary nesting and OR logic
- Evaluates rules and groups that were not safely applied by Plex
- Rechecks top-level `any` filters in full because one pushed branch cannot prove the whole OR

### When Each Strategy Is Used

| Filter Structure            | Server-Side | Residual Evaluation | Notes                                                |
| --------------------------- | ----------- | ------------------- | ---------------------------------------------------- |
| Supported simple AND        | Yes         | No                  | Every rule was safely applied by Plex                |
| AND with unsupported rules  | Partial     | Yes                 | Only exact applied rules are skipped locally         |
| Top-level OR (`match: any`) | No          | Yes                 | The complete OR expression is evaluated locally      |
| Nested groups               | Partial     | Yes                 | Safe top-level rules may still reduce server results |
| One supported OR group      | Variants    | Yes                 | Branch queries are combined and IDs are deduplicated |

### Performance Implications

**Best Performance:** Pure AND filters with simple rules:

```yaml
plexFilters:
  efficient-filter:
    match: all
    rules:
      - type: rule
        field: artistRating
        operator: ">="
        value: 4
      - type: rule
        field: genre
        operator: contains
        value: Rock
```

**Moderate Performance:** AND filter with nested OR groups:

```yaml
plexFilters:
  moderate-filter:
    match: all
    rules:
      - type: rule
        field: artistRating
        operator: ">="
        value: 3
      - type: group
        match: any # This part requires client-side
        rules:
          - type: rule
            field: genre
            operator: contains
            value: Rock
          - type: rule
            field: genre
            operator: contains
            value: Pop
```

The server may filter by a supported rating rule, then the generic residual evaluator applies the
genre OR logic to mapped media entities. Supported OR branches may instead be issued as separate
query variants; combined results are deduplicated by their opaque media IDs.

**Lower Performance:** Top-level OR filters:

```yaml
plexFilters:
  full-client-filter:
    match: any # All server results required
    rules:
      - type: rule
        field: artistRating
        operator: ">="
        value: 5
      - type: rule
        field: genre
        operator: contains
        value: Jazz
```

The top-level OR expression is evaluated locally so a partial server match cannot change its
meaning.

### Limit Adjustment

When residual filtering removes items, rfmedia advances using the number of items returned by the
server and continues page by page until the requested result limit is satisfied or Plex reports no
more results. This response-driven pagination avoids a fixed over-fetch multiplier and detects a
stalled page instead of looping indefinitely.

## Troubleshooting

### Common Errors

**Filter Not Found:**

```
Error: Filter "my-filter" not found in plexFilters config. Available: other-filter
```

**Causes:**

1. Filter name typo in command
2. Filter not defined in config file
3. Wrong config file loaded

**Solution:** Verify the filter name matches exactly:

```bash
# Check available filters
cat .rfmedia.yaml | grep -A 1 "plexFilters:"
```

**Invalid Field for Operator:**

```
Error: Operator "contains" is not valid for field "artistRating"
```

**Solution:** Use appropriate operators for field types. Rating fields require numeric operators (`>=`, `<=`, `==`).

**Invalid Rating Value:**

```
Error: Rating value must be between 1 and 5, got 10
```

**Solution:** Use the 1-5 star scale (not the internal 0-10 scale):

```yaml
# Correct
- type: rule
  field: artistRating
  operator: ">="
  value: 4

# Wrong - internal scale
- type: rule
  field: artistRating
  operator: ">="
  value: 8
```

### No Results Returned

**Possible Causes:**

1. **Filter too restrictive**: Multiple AND conditions might eliminate all results
2. **Wrong library**: Filter's default library does not exist or is misspelled
3. **Rating field mismatch**: Using `trackRating` on artist query
4. **Case sensitivity**: Genre or artist names must match Plex data

**Debugging Steps:**

1. Test with a simpler filter:

   ```yaml
   test-filter:
     match: all
     rules:
       - type: rule
         field: artistRating
         operator: ">="
         value: 1
   ```

2. Use `--debug` to see extracted conditions:

   ```bash
   rfmedia plex query run --filter my-filter --debug
   ```

3. Verify the library and type:

   ```bash
   rfmedia plex query run -l Music -t track --debug
   ```

### YAML Syntax Errors

**Issue: Unquoted operators**

```
Error: YAML parsing failed: can not read a block mapping entry
```

**Solution:** Quote operators containing special characters:

```yaml
# Correct
operator: ">="

# Wrong (may cause parsing issues)
operator: >=
```

**Issue: Indentation error**

```
Error: YAML parsing failed: bad indentation
```

**Solution:** Use consistent 2-space indentation:

```yaml
# Correct
plexFilters:
  my-filter:
    match: all
    rules:
      - type: rule
        field: artistRating
        operator: ">="
        value: 4

# Wrong (inconsistent indentation)
plexFilters:
  my-filter:
   match: all
    rules:
```

### Debug Output Interpretation

When running with `--debug`, look for these key messages:

```
[DEBUG] Loaded Plex filter: high-rated-tracks
[DEBUG] Server conditions extracted: {"minArtistRating":8}
[DEBUG] Client-side filtering required: false
[DEBUG] Query returned 150 results
```

Key indicators:

- **Server conditions extracted**: Shows what was optimized for server-side filtering
- **Client-side filtering required**: Whether OR logic requires local evaluation
- **Query returned**: Initial result count before any client filtering
- **Client-side filter**: Shows before/after counts if client filtering applied

## Filter Defaults and CLI Override

### Default Settings in Filters

Filters can specify default values for common options:

```yaml
plexFilters:
  my-filter:
    match: all
    library: Music # Default library
    type: track # Default media type
    limit: 100 # Default result limit
    rules:
      -  # ...
```

### CLI Override Precedence

CLI options always take precedence over filter defaults:

```bash
# Uses filter default library (Music) and type (track)
rfmedia plex query run --filter my-filter

# Overrides filter's library default
rfmedia plex query run --filter my-filter -l "My Music"

# Overrides filter's type default
rfmedia plex query run --filter my-filter -t album

# Overrides filter's limit default
rfmedia plex query run --filter my-filter --limit 50
```

### Precedence Order

1. CLI options (highest priority)
2. Filter defaults
3. Config defaults (`plex.defaultLibrary`)
4. System defaults (lowest priority)

## Related Documentation

- [README.md](../../README.md) - Command reference and usage examples
- [Media Server Adapter](media-server-adapter.md) - Generic capability and private provider boundary
- [Plex Metadata Sync](plex-metadata-sync.md) - Normalized ratings and Plex compatibility scales
- [smart-filters.md](smart-filters.md) - Local file smart filters (similar concepts)
- [tracking-system.md](tracking-system.md) - Operation tracking details
