/**
 * Diagnosis engine — design.md §4.
 *
 * A pure function `CheckResult[] -> Diagnosis[]`. No I/O, no network, no
 * filesystem, no SDK import. That constraint is not stylistic: it is what makes
 * exhaustive combination testing cheap, and it is enforced at lint time by an
 * import restriction on `src/diagnosis/**` rather than left to review.
 *
 * Why this layer exists at all: a check only knows about itself. "the installed
 * SDK is 0.1.2" and "the process did not exit" are two independent facts in
 * isolation, and a single high-confidence cause together. Correlating after the
 * fact is the only way to get that without duplicating version-awareness logic
 * into every check that might care.
 */

import type { CheckResult, CheckStatus, Diagnosis } from "../types.js";

/**
 * Read-only view over one run's results, handed to each rule.
 *
 * Rules never see the array directly — a rule that could iterate could also
 * accumulate state across calls, and the engine's determinism depends on rules
 * being pure functions of the results they declare.
 */
export interface ResultLookup {
  /** The result for a check id, or `undefined` if it did not run. */
  get(id: string): CheckResult | undefined;
  /** The status for a check id, or `undefined` if it did not run. */
  status(id: string): CheckStatus | undefined;
  /** True when the check ran and its status is one of `statuses`. */
  is(id: string, ...statuses: CheckStatus[]): boolean;
  /** A single evidence value, or `undefined`. Never throws on a missing key. */
  evidence(id: string, key: string): unknown;
}

export interface DiagnosisRule {
  /** Stable id for the rule itself — not a check id. */
  id: string;
  /**
   * Check ids this rule reads. Becomes `supportingChecks`, filtered to those
   * that actually produced a result, so a diagnosis never cites a check that
   * did not run.
   */
  reads: readonly string[];
  /** Pure predicate. Must not close over anything mutable. */
  matches(results: ResultLookup): boolean;
  cause: string;
  confidence: Diagnosis["confidence"];
  remediation: string;
  issueRef?: string;
}

function createLookup(results: readonly CheckResult[]): ResultLookup {
  const byId = new Map(results.map((r) => [r.id, r]));
  return {
    get: (id) => byId.get(id),
    status: (id) => byId.get(id)?.status,
    is: (id, ...statuses) => {
      const status = byId.get(id)?.status;
      return status !== undefined && statuses.includes(status);
    },
    evidence: (id, key) => byId.get(id)?.evidence?.[key],
  };
}

/**
 * Correlates results into named causes.
 *
 * Deterministic: the same results always produce the same diagnoses, in rule
 * declaration order. Ordering for display is the renderer's concern — sorting
 * here would bake presentation into the logic layer.
 *
 * A rule that throws is a defect in that rule, not a reason to lose every other
 * diagnosis, so it is contained and skipped. This mirrors the scheduler's
 * treatment of a check that throws.
 */
export function diagnose(
  results: readonly CheckResult[],
  rules: readonly DiagnosisRule[],
): Diagnosis[] {
  const lookup = createLookup(results);
  const ran = new Set(results.map((r) => r.id));
  const diagnoses: Diagnosis[] = [];

  for (const rule of rules) {
    let matched: boolean;
    try {
      matched = rule.matches(lookup);
    } catch {
      continue;
    }
    if (!matched) continue;

    diagnoses.push({
      cause: rule.cause,
      confidence: rule.confidence,
      remediation: rule.remediation,
      supportingChecks: rule.reads.filter((id) => ran.has(id)),
      ...(rule.issueRef !== undefined ? { issueRef: rule.issueRef } : {}),
    });
  }

  return diagnoses;
}
