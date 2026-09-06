/**
 * JSON renderer — design.md §4 and §9.
 *
 * Returns a string; the CLI writes it. `--json` is the CI-pipeable form, so the
 * shape is versioned from v1 (§9): a future consumer must never have to guess
 * which shape an old payload is in.
 *
 * `schemaVersion` is shared with the `--report` bundle deliberately. They are
 * the same data at different levels of detail, and two independently drifting
 * version numbers would be worse than one.
 */

import type { CheckResult, Diagnosis } from "../types.js";

/** design.md §9: "`--report` output is versioned from v1". */
export const SCHEMA_VERSION = 1;

export interface JsonReport {
  schemaVersion: number;
  checks: readonly CheckResult[];
  diagnoses: readonly Diagnosis[];
}

export function buildJsonReport(
  results: readonly CheckResult[],
  diagnoses: readonly Diagnosis[],
): JsonReport {
  return { schemaVersion: SCHEMA_VERSION, checks: results, diagnoses };
}

/**
 * Pretty-printed, with a trailing newline so shell redirection produces a
 * well-formed file rather than one missing its final newline.
 *
 * `JSON.stringify` drops `undefined` values, which aligns with the
 * `exactOptionalPropertyTypes` convention (CLAUDE.md §17 rule 1): an optional
 * field that was never set is absent from the output rather than serialised
 * as `null`.
 */
export function renderJson(
  results: readonly CheckResult[],
  diagnoses: readonly Diagnosis[],
): string {
  return `${JSON.stringify(buildJsonReport(results, diagnoses), null, 2)}\n`;
}
