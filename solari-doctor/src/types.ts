/**
 * Core data contracts — design.md §5.
 *
 * Types and interfaces only. No logic lives here, and nothing is added beyond
 * what §5 locks: shared vocabulary is defined once and imported (design.md
 * §8.1), so a field invented locally by a check is a defect, not a shortcut.
 */

import type { DoctorContext } from "./context.js";

/**
 * The verdict of a single check, as a fact rather than a conclusion.
 *
 * `skip` is specifically the status used when a dependency failed (design.md
 * §7) — the blocking check must be named in `message`. It must never be used
 * to hide an error the check actually hit; that is `fail`.
 */
export type CheckStatus = "pass" | "warn" | "fail" | "skip";

/**
 * Drives scheduling and default-vs-`--full` (design.md §7).
 *
 * This lives on the check itself rather than in a separate config so it cannot
 * drift from the code it governs. A wrong value here creates real, billable
 * resources — treat it as a resource-safety bug, not a cosmetic one.
 */
export type CostTier = "free" | "cheap" | "expensive";

/** How strongly the supporting facts imply a named cause. */
export type Confidence = "low" | "medium" | "high";

/** What one check observed. Facts and evidence — never a rendered verdict. */
export interface CheckResult {
  /** The producing check's id; one of the seven locked ids (design.md §6). */
  id: string;
  status: CheckStatus;
  /** One-line summary. For `skip`, must name the blocking check. */
  message: string;
  details?: string;
  /** What to do about it. Traceable to docs or an issue (design.md §3). */
  remediation?: string;
  /** Wall-clock duration in ms. Populated even for `skip` (expected ~0). */
  durationMs: number;
  /** e.g. `"solari-cookbook#25"`. Never invented — verified issues only. */
  issueRef?: string;
  /**
   * Structured facts actually observed. First-class, not an afterthought:
   * `--report` is the accumulated evidence, so it is cheap only if checks
   * populate this properly.
   *
   * Never secrets. Every new key needs a `--report` safety verdict before it
   * ships (design.md §9).
   */
  evidence?: Record<string, unknown>;
}

/** The single abstraction for a check. There is no second check shape. */
export interface DoctorCheck {
  /** Stable id; also the value accepted by `--explain <id>`. */
  id: string;
  description: string;
  /** Ids that must pass first. Currently only `auth` is ever a dependency. */
  dependsOn?: string[];
  costTier: CostTier;
  /**
   * Runs the check and returns facts.
   *
   * Must not print (design.md §4). Must not throw for an expected failure —
   * it returns `status: "fail"` instead.
   */
  run(ctx: DoctorContext): Promise<CheckResult>;
}

/**
 * A named cause produced by correlating several `CheckResult`s.
 *
 * Produced by a pure function `CheckResult[] -> Diagnosis[]` (design.md §4):
 * the same inputs always produce the same output, with no I/O anywhere.
 */
export interface Diagnosis {
  /** e.g. "known lifecycle bug in SDK <0.1.3". Derivable from the support. */
  cause: string;
  confidence: Confidence;
  remediation: string;
  /** Non-empty; every id must appear in the results that produced this. */
  supportingChecks: string[];
  issueRef?: string;
}
