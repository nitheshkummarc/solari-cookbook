/**
 * The check registry — design.md §15.
 *
 * This module is "the only place that knows the full list of checks". Nothing
 * else in the codebase may enumerate them: no second array, no switch on check
 * ids, no per-check branching anywhere downstream. Adding or removing a check
 * is a one-line change to `CHECKS` below and nowhere else.
 *
 * The registry identifies and validates checks. It does not run them and does
 * not decide execution order — `free` before bounded, dependency waiting and
 * concurrency all belong to the scheduler (design.md §7, module 4).
 */

import type { DoctorCheck } from "../types.js";

/** What the scheduler and `--explain` consume. Deliberately read-only. */
export interface CheckRegistry {
  /** Every registered check, in registration order. Frozen. */
  all(): readonly DoctorCheck[];
  /** Every registered id, in registration order. Frozen. */
  ids(): readonly string[];
  /** The check with this id, or `undefined`. Used by `--explain <id>`. */
  get(id: string): DoctorCheck | undefined;
  has(id: string): boolean;
}

/**
 * Builds a registry, rejecting a malformed set loudly rather than limping on.
 *
 * Both validations below are programmer errors — a broken build, not a
 * diagnosable user environment — so they throw at construction rather than
 * producing a `CheckResult`. A tool that reports on other people's
 * environments has no business starting up in a knowingly inconsistent state.
 */
export function createCheckRegistry(
  checks: readonly DoctorCheck[],
): CheckRegistry {
  const byId = new Map<string, DoctorCheck>();

  for (const check of checks) {
    const existing = byId.get(check.id);
    if (existing !== undefined) {
      // Silently overwriting would mean a check the user believes ran did not,
      // and the duplicate would be invisible in every output.
      throw new Error(
        `Duplicate check id "${check.id}" in the registry. Each check id must ` +
          `be unique — ids appear in CheckResult.id, in --explain, and in ` +
          `dependsOn, so a duplicate makes all three ambiguous.`,
      );
    }
    byId.set(check.id, check);
  }

  // design.md §5: `dependsOn` "must reference ids that exist in the registry".
  // This is the only place with full knowledge of the id set, so it is the
  // only place that can enforce it. Cycle detection needs the dependency
  // graph and belongs to the scheduler (module 4), not here.
  for (const check of checks) {
    for (const dependency of check.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw new Error(
          `Check "${check.id}" depends on "${dependency}", which is not ` +
            `registered. A dangling dependency would make the check skip ` +
            `forever with no explanation.`,
        );
      }
    }
  }

  const ordered = Object.freeze([...checks]);
  const orderedIds = Object.freeze(ordered.map((c) => c.id));

  return {
    all: () => ordered,
    ids: () => orderedIds,
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
  };
}

/**
 * The static list. Empty until the checks themselves are built.
 *
 * The seven locked checks (design.md §6) arrive in build order: `auth` and
 * `sdk-version` (modules 9-10), `browser-lifecycle` (11), `sandbox-command`
 * and `sandbox-cleanup` (12), `session-liveness` and `recording-lifecycle`
 * (13). Seven is a cap, not a target — design.md §13 forbids an eighth.
 *
 * An empty registry is a valid state, not an error: it is what this file
 * legitimately holds right now, and a run over it should report nothing rather
 * than crash.
 */
const CHECKS: readonly DoctorCheck[] = [];

/** The registry the CLI uses. */
export const registry: CheckRegistry = createCheckRegistry(CHECKS);
