#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPackageRoot = resolve(scriptDir, "..");

const PRIVATE_PLEX_DIRECTORY = "src/lib/adapters/plex/";
const PRIVATE_PLEX_COMPOSER = "src/lib/adapters/plex-adapter.ts";
const PLEX_FETCH_OWNER = "src/lib/adapters/plex/client.ts";
const PLEX_ENROLLMENT_FETCH_OWNER = "src/lib/adapters/plex/enrollment-client.ts";
const PRIVATE_LIDARR_GENERATED_DIRECTORY = "src/lib/lidarr/generated/";
const LIDARR_GENERATED_IMPORTER = "src/lib/lidarr/client.ts";
const LIDARR_FETCH_OWNER = "src/lib/lidarr/transport.ts";
const LASTFM_FETCH_OWNER = "src/lib/discovery/lastfm.ts";
const LIDARR_OPERATION_OWNER = "src/lib/lidarr/plan-operation-definitions.ts";
const LIDARR_RESILIENCE_DECORATOR = "src/lib/lidarr/resilience.ts";
const MUSICBRAINZ_DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const LIDARR_GENERATED_EDITOR_OPERATIONS = new Set([
  "deleteApiV1ArtistEditor",
  "putApiV1ArtistEditor",
]);
const LIDARR_EDITOR_BODY_TYPES = new Set([
  "ArtistEditorResource",
  "DeleteApiV1ArtistEditorData",
  "PutApiV1ArtistEditorData",
]);
const LIDARR_EDITOR_BODY_MUTATION_KEYS = new Set([
  "addImportListExclusion",
  "applyTags",
  "deleteFiles",
  "metadataProfileId",
  "moveFiles",
  "qualityProfileId",
  "rootFolderPath",
  "tags",
]);
const LIDARR_PROFILE_TAG_MUTATION_METHODS = new Set(["setArtistProfiles", "updateArtistTags"]);
const LIDARR_PROFILE_TAG_MUTATION_OWNERS = new Set([
  LIDARR_OPERATION_OWNER,
  LIDARR_RESILIENCE_DECORATOR,
]);
const LIDARR_ALBUM_OPERATION_OWNER = "src/lib/lidarr/plan-album-operations.ts";
const LIDARR_ALBUM_MUTATION_METHODS = new Set(["deleteAlbum", "setAlbumAnyReleaseOk"]);
const LIDARR_ALBUM_MUTATION_OWNERS = new Set([
  LIDARR_ALBUM_OPERATION_OWNER,
  LIDARR_RESILIENCE_DECORATOR,
]);
const LIDARR_TRACK_FILTER_OPERATION_OWNER = "src/actions/lidarr/apply-track-filter-execution.ts";
const LIDARR_TRACK_FILTER_MUTATION_METHODS = new Set(["bulkDeleteTrackFiles"]);
const LIDARR_TRACK_FILTER_MUTATION_OWNERS = new Set([
  LIDARR_TRACK_FILTER_OPERATION_OWNER,
  LIDARR_RESILIENCE_DECORATOR,
]);
const LIDARR_ARTIST_ADD_OPERATION_OWNER = "src/actions/lidarr/apply-artist-add-entry-execution.ts";
const LIDARR_ARTIST_ADD_MUTATION_METHODS = new Set(["addArtist"]);
const LIDARR_ARTIST_ADD_MUTATION_OWNERS = new Set([
  LIDARR_ARTIST_ADD_OPERATION_OWNER,
  LIDARR_RESILIENCE_DECORATOR,
]);
const LIDARR_ALBUM_MONITORING_OPERATION_OWNER = "src/lib/lidarr/plan-engine.ts";
const LIDARR_ALBUM_MONITORING_MUTATION_METHODS = new Set(["setAlbumsMonitored"]);
const LIDARR_ALBUM_MONITORING_MUTATION_OWNERS = new Set([
  LIDARR_ALBUM_MONITORING_OPERATION_OWNER,
  LIDARR_ARTIST_ADD_OPERATION_OWNER,
  LIDARR_RESILIENCE_DECORATOR,
]);

/**
 * Client mutation methods restricted to registered operation ownership paths.
 * Each rule is a pure call-site allowlist: owner modules are not required to
 * exist, so trees with zero call sites (or that predate an owner) still pass.
 */
const LIDARR_MUTATION_OWNERSHIP_RULES = [
  {
    rule: "lidarr-profile-tag-mutation-owner",
    methods: LIDARR_PROFILE_TAG_MUTATION_METHODS,
    owners: LIDARR_PROFILE_TAG_MUTATION_OWNERS,
  },
  {
    rule: "lidarr-album-mutation-owner",
    methods: LIDARR_ALBUM_MUTATION_METHODS,
    owners: LIDARR_ALBUM_MUTATION_OWNERS,
  },
  {
    rule: "lidarr-track-filter-mutation-owner",
    methods: LIDARR_TRACK_FILTER_MUTATION_METHODS,
    owners: LIDARR_TRACK_FILTER_MUTATION_OWNERS,
  },
  {
    rule: "lidarr-artist-add-mutation-owner",
    methods: LIDARR_ARTIST_ADD_MUTATION_METHODS,
    owners: LIDARR_ARTIST_ADD_MUTATION_OWNERS,
  },
  {
    rule: "lidarr-album-monitoring-mutation-owner",
    methods: LIDARR_ALBUM_MONITORING_MUTATION_METHODS,
    owners: LIDARR_ALBUM_MONITORING_MUTATION_OWNERS,
  },
];

/**
 * The full set of production modules permitted to call `fetch`. Each owner must
 * contain exactly one fetch call site. A fetch in any other production file is a
 * boundary violation reported as `plex-fetch-owner`.
 *
 * - `alwaysRequired: true` enforces the exactly-one-fetch invariant even when the
 *   file is absent from the scanned tree (the Plex client is a permanent fixture).
 * - `alwaysRequired: false` enforces the invariant only when the file is present,
 *   so trees that predate the Lidarr or Last.fm clients are not tripped by
 *   their absence.
 */
const FETCH_OWNERS = new Map([
  [PLEX_FETCH_OWNER, { countRule: "plex-fetch-owner-count", alwaysRequired: true }],
  [
    PLEX_ENROLLMENT_FETCH_OWNER,
    { countRule: "plex-enrollment-fetch-owner-count", alwaysRequired: false },
  ],
  [LIDARR_FETCH_OWNER, { countRule: "lidarr-fetch-owner-count", alwaysRequired: false }],
  [LASTFM_FETCH_OWNER, { countRule: "lastfm-fetch-owner-count", alwaysRequired: false }],
]);

/**
 * Plex compatibility types are permitted only at established public projection
 * and configuration boundaries. Generic contracts and helpers must not add to
 * this list.
 */
const PLEX_COMPATIBILITY_ALLOWLIST = new Set([
  "src/actions/plex-collection.ts",
  "src/actions/plex-copy.ts",
  "src/actions/plex-playlist.ts",
  "src/actions/plex-query.ts",
  "src/actions/plex-sync.ts",
  "src/commands/plex.ts",
  "src/lib/adapters/plex/mappers.ts",
  "src/lib/config.ts",
  "src/mcp/adapters.ts",
  "src/mcp/schema.ts",
  "src/types/index.ts",
]);

const LEGACY_PLEX_MODULES = new Set([
  "src/lib/plex",
  "src/lib/plex-cache",
  "src/lib/plex-filter-evaluator",
  "src/lib/plex-pagination",
]);
const MODULE_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g;
const REEXPORT_PATTERN = /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s*["']([^"']+)["']/g;
const GENERATED_IMPORT_PATTERN = /\bimport\s+(?:type\s+)?([^;]*?)\s+from\s*["']([^"']+)["']/g;
const LOCAL_EXPORT_PATTERN = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)/g;
const FETCH_CALL_PATTERN = /\b(?:fetch|trustedFetch)\s*\(/g;

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function isProductionTypeScriptFile(name) {
  return (
    name.endsWith(".ts") &&
    !name.endsWith(".d.ts") &&
    !name.includes(".test.") &&
    !name.includes(".spec.")
  );
}

function collectProductionFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
      continue;
    }

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectProductionFiles(absolutePath));
    } else if (entry.isFile() && isProductionTypeScriptFile(entry.name)) {
      files.push(absolutePath);
    }
  }

  return files;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function resolveLocalModule(packageRoot, importerPath, specifier) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const target = toPosixPath(relative(packageRoot, resolve(dirname(importerPath), specifier)));
  return target.replace(/\.(?:js|ts)$/, "");
}

function isGeneratedModule(target) {
  return (
    target === PRIVATE_LIDARR_GENERATED_DIRECTORY.slice(0, -1) ||
    target?.startsWith(PRIVATE_LIDARR_GENERATED_DIRECTORY)
  );
}

function isMusicBrainzDependency(specifier) {
  return !specifier.startsWith(".") && specifier.toLowerCase().includes("musicbrainz");
}

function auditMusicBrainzManifest(packageRoot, violations) {
  const manifestPath = join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) return;

  const content = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(content);
  for (const section of MUSICBRAINZ_DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
      continue;
    }
    for (const dependency of Object.keys(dependencies)) {
      if (!dependency.toLowerCase().includes("musicbrainz")) continue;
      const key = JSON.stringify(dependency);
      violations.push({
        file: "package.json",
        line: lineNumberAt(content, Math.max(content.indexOf(key), 0)),
        rule: "musicbrainz-dependency",
        detail: `declares out-of-scope MusicBrainz dependency ${dependency}`,
      });
    }
  }
}

function captureStart(match, capture) {
  return (match.index ?? 0) + match[0].lastIndexOf(capture);
}

function importedBindings(clause) {
  const bindings = new Set();
  const named = clause.match(/\{([^}]*)\}/s)?.[1];
  if (named !== undefined) {
    for (const entry of named.split(",")) {
      const normalized = entry.trim().replace(/^type\s+/, "");
      if (normalized.length === 0) continue;
      const parts = normalized.split(/\s+as\s+/);
      bindings.add(parts.at(-1));
    }
  }

  const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/u)?.[1];
  if (namespace !== undefined) bindings.add(namespace);

  const defaultBinding = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/u)?.[1];
  if (defaultBinding !== undefined) bindings.add(defaultBinding);
  return bindings;
}

function exportedBindings(clause) {
  const bindings = new Set();
  for (const entry of clause.split(",")) {
    const normalized = entry.trim().replace(/^type\s+/, "");
    if (normalized.length === 0) continue;
    bindings.add(normalized.split(/\s+as\s+/)[0]);
  }
  return bindings;
}

function collectStringLiterals(content) {
  const literals = [];
  let index = 0;

  while (index < content.length) {
    if (content[index] === "/" && content[index + 1] === "/") {
      index += 2;
      while (index < content.length && content[index] !== "\n") index += 1;
      continue;
    }
    if (content[index] === "/" && content[index + 1] === "*") {
      index += 2;
      while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }

    const quote = content[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      index += 1;
      continue;
    }

    const start = index;
    let value = "";
    index += 1;
    while (index < content.length && content[index] !== quote) {
      if (content[index] === "\\" && index + 1 < content.length) {
        value += content.slice(index, index + 2);
        index += 2;
      } else {
        value += content[index];
        index += 1;
      }
    }
    if (index < content.length) index += 1;
    literals.push({ index: start, value });
  }

  return literals;
}

function sourceLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function propertyNameText(name) {
  if (name === undefined) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function objectLiteralPropertyNames(node) {
  const names = new Set();
  for (const property of node.properties) {
    if (
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property) ||
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property)
    ) {
      const name = propertyNameText(property.name);
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

function typeReferenceName(node) {
  return ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;
}

function elementAccessPropertyName(node) {
  const argument = node.argumentExpression;
  return argument !== undefined &&
    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function mutationMethodFromExpression(expression, checker, methods, seenSymbols = new Set()) {
  if (ts.isPropertyAccessExpression(expression)) {
    return methods.has(expression.name.text) ? expression.name.text : undefined;
  }
  if (ts.isElementAccessExpression(expression)) {
    const name = elementAccessPropertyName(expression);
    return name !== undefined && methods.has(name) ? name : undefined;
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return mutationMethodFromExpression(expression.expression, checker, methods, seenSymbols);
  }
  if (!ts.isIdentifier(expression)) return undefined;

  const symbol = checker.getSymbolAtLocation(expression);
  if (symbol === undefined || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const method = mutationMethodFromExpression(
        declaration.initializer,
        checker,
        methods,
        seenSymbols,
      );
      if (method !== undefined) return method;
    }
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const name = propertyNameText(declaration.propertyName ?? declaration.name);
      if (name !== undefined && methods.has(name)) return name;
    }
  }
  return undefined;
}

function auditLidarrEditorOwnership(file, sourceFile, checker, generatedFile, violations) {
  if (generatedFile) return;

  function visit(node) {
    if (file !== LIDARR_GENERATED_IMPORTER) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        LIDARR_GENERATED_EDITOR_OPERATIONS.has(node.expression.text)
      ) {
        violations.push({
          file,
          line: sourceLine(sourceFile, node),
          rule: "lidarr-generated-editor-owner",
          detail: `invokes generated editor operation ${node.expression.text} outside ${LIDARR_GENERATED_IMPORTER}`,
        });
      }

      if (ts.isTypeReferenceNode(node) && LIDARR_EDITOR_BODY_TYPES.has(typeReferenceName(node))) {
        violations.push({
          file,
          line: sourceLine(sourceFile, node),
          rule: "lidarr-editor-body-owner",
          detail: `uses broad generated editor body type ${typeReferenceName(node)} outside ${LIDARR_GENERATED_IMPORTER}`,
        });
      }

      if (ts.isObjectLiteralExpression(node)) {
        const keys = objectLiteralPropertyNames(node);
        const mutationKeys = [...LIDARR_EDITOR_BODY_MUTATION_KEYS].filter((key) => keys.has(key));
        if (keys.has("artistIds") && mutationKeys.length > 0) {
          violations.push({
            file,
            line: sourceLine(sourceFile, node),
            rule: "lidarr-editor-body-owner",
            detail: `constructs an artist-editor-shaped body outside ${LIDARR_GENERATED_IMPORTER} (${mutationKeys.join(", ")})`,
          });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      for (const ownership of LIDARR_MUTATION_OWNERSHIP_RULES) {
        if (ownership.owners.has(file)) continue;
        const mutationMethod = mutationMethodFromExpression(
          node.expression,
          checker,
          ownership.methods,
        );
        if (mutationMethod !== undefined) {
          violations.push({
            file,
            line: sourceLine(sourceFile, node),
            rule: ownership.rule,
            detail: `invokes ${mutationMethod} outside the registered operation ownership path`,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/**
 * Audit dependency direction and authenticated HTTP ownership for Plex and Lidarr.
 *
 * @param {string} packageRoot - Root of the rfmedia package containing `src/`.
 * @returns {{ filesScanned: number, violations: Array<{ file: string, line: number, rule: string, detail: string }> }}
 */
export function auditPlexBoundaries(packageRoot = defaultPackageRoot) {
  const resolvedPackageRoot = resolve(packageRoot);
  const sourceRoot = join(resolvedPackageRoot, "src");
  const files = collectProductionFiles(sourceRoot);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noResolve: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const violations = [];
  auditMusicBrainzManifest(resolvedPackageRoot, violations);
  const fetchOwnerState = new Map();
  for (const [ownerFile, config] of FETCH_OWNERS) {
    fetchOwnerState.set(ownerFile, { seen: false, count: 0, ...config });
  }

  for (const absolutePath of files) {
    const file = toPosixPath(relative(resolvedPackageRoot, absolutePath));
    const content = readFileSync(absolutePath, "utf8");
    const sourceFile = program.getSourceFile(absolutePath);
    if (sourceFile === undefined) {
      throw new Error(`TypeScript did not load production source ${file}`);
    }
    const generatedFile = file.startsWith(PRIVATE_LIDARR_GENERATED_DIRECTORY);
    const modulePattern = new RegExp(MODULE_SPECIFIER_PATTERN.source, "g");
    const reexportPattern = new RegExp(REEXPORT_PATTERN.source, "g");
    const generatedImportPattern = new RegExp(GENERATED_IMPORT_PATTERN.source, "g");
    const localExportPattern = new RegExp(LOCAL_EXPORT_PATTERN.source, "g");
    const generatedReexportSpecifiers = new Set();
    const generatedBindings = new Set();

    auditLidarrEditorOwnership(file, sourceFile, checker, generatedFile, violations);

    for (const match of content.matchAll(reexportPattern)) {
      const specifier = match[1];
      const target = resolveLocalModule(resolvedPackageRoot, absolutePath, specifier);
      if (!generatedFile && isGeneratedModule(target)) {
        generatedReexportSpecifiers.add(captureStart(match, specifier));
        violations.push({
          file,
          line: lineNumberAt(content, match.index ?? 0),
          rule: "lidarr-generated-reexport",
          detail: `re-exports symbols from private generated module ${specifier}`,
        });
      }
    }

    if (!generatedFile) {
      for (const match of content.matchAll(generatedImportPattern)) {
        const target = resolveLocalModule(resolvedPackageRoot, absolutePath, match[2]);
        if (isGeneratedModule(target)) {
          for (const binding of importedBindings(match[1])) generatedBindings.add(binding);
        }
      }
      if (generatedBindings.size > 0) {
        for (const match of content.matchAll(localExportPattern)) {
          const leakedBindings = [...exportedBindings(match[1])].filter((binding) =>
            generatedBindings.has(binding),
          );
          if (leakedBindings.length > 0) {
            violations.push({
              file,
              line: lineNumberAt(content, match.index ?? 0),
              rule: "lidarr-generated-reexport",
              detail: `re-exports imported generated symbol${leakedBindings.length === 1 ? "" : "s"} ${leakedBindings.join(", ")}`,
            });
          }
        }
      }
    }

    for (const match of content.matchAll(modulePattern)) {
      const specifier = match[1];
      const line = lineNumberAt(content, match.index ?? 0);
      const target = resolveLocalModule(resolvedPackageRoot, absolutePath, specifier);
      const specifierStart = captureStart(match, specifier);

      if (isMusicBrainzDependency(specifier)) {
        violations.push({
          file,
          line,
          rule: "musicbrainz-dependency",
          detail: `imports out-of-scope MusicBrainz dependency ${specifier}`,
        });
      }

      if (target && LEGACY_PLEX_MODULES.has(target)) {
        violations.push({
          file,
          line,
          rule: "legacy-plex-module",
          detail: `imports deleted legacy module ${specifier}`,
        });
      }

      if (
        target?.startsWith("src/lib/adapters/plex/") &&
        !file.startsWith(PRIVATE_PLEX_DIRECTORY) &&
        file !== PRIVATE_PLEX_COMPOSER
      ) {
        violations.push({
          file,
          line,
          rule: "private-plex-import",
          detail: `imports private adapter module ${specifier}`,
        });
      }

      if (target === "src/types/plex" && !PLEX_COMPATIBILITY_ALLOWLIST.has(file)) {
        violations.push({
          file,
          line,
          rule: "plex-compatibility-import",
          detail: `uses Plex compatibility types outside the documented allowlist`,
        });
      }

      if (
        !generatedFile &&
        isGeneratedModule(target) &&
        file !== LIDARR_GENERATED_IMPORTER &&
        !generatedReexportSpecifiers.has(specifierStart)
      ) {
        violations.push({
          file,
          line,
          rule: "private-lidarr-generated-import",
          detail: `imports private generated Lidarr module ${specifier}`,
        });
      }
    }

    if (!generatedFile) {
      for (const literal of collectStringLiterals(content)) {
        if (literal.value.includes("/api/v1/")) {
          violations.push({
            file,
            line: lineNumberAt(content, literal.index),
            rule: "handwritten-lidarr-api-path",
            detail: "contains a handwritten Lidarr /api/v1/ path literal",
          });
        }
      }
    }

    const fetchSites = generatedFile ? [] : [...content.matchAll(FETCH_CALL_PATTERN)];
    const ownerState = fetchOwnerState.get(file);
    if (ownerState) {
      ownerState.seen = true;
      ownerState.count = fetchSites.length;
    } else {
      for (const fetchSite of fetchSites) {
        violations.push({
          file,
          line: lineNumberAt(content, fetchSite.index ?? 0),
          rule: "plex-fetch-owner",
          detail: `owns a fetch outside the authorized client boundary (${[...FETCH_OWNERS.keys()].join(", ")})`,
        });
      }
    }
  }

  for (const [ownerFile, state] of fetchOwnerState) {
    const enforce = state.alwaysRequired || state.seen;
    if (enforce && state.count !== 1) {
      violations.push({
        file: ownerFile,
        line: 1,
        rule: state.countRule,
        detail: `must contain exactly one fetch site; found ${state.count}`,
      });
    }
  }

  return { filesScanned: files.length, violations };
}

export function formatAuditFailure(result) {
  const lines = ["rfmedia architecture violations found:"];
  for (const violation of result.violations) {
    lines.push(` - ${violation.file}:${violation.line} [${violation.rule}] ${violation.detail}`);
  }
  return lines.join("\n");
}

function main() {
  const packageRoot = process.argv[2] ? resolve(process.argv[2]) : defaultPackageRoot;
  const result = auditPlexBoundaries(packageRoot);

  if (result.violations.length > 0) {
    console.error(formatAuditFailure(result));
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: Plex/Lidarr dependency direction and authenticated fetch ownership across ${result.filesScanned} production files.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
