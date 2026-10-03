/**
 * YAML serializer for machine-readable output.
 *
 * Uses the `yaml` package (v2) for consistent YAML serialization
 * across all rfmedia CLI tools.
 */

import YAML from "yaml";

/**
 * Format data as a YAML string.
 *
 * @param data - Any serializable value to format as YAML
 * @returns YAML-formatted string
 */
export function formatAsYaml(data: unknown): string {
  return YAML.stringify(data);
}
