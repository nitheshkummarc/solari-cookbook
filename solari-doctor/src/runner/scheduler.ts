/**
 * Dependency-aware scheduler — design.md §7.
 *
 * Responsibilities, and nothing else:
 *   - order execution by dependency and cost tier
 *   - bound concurrency for checks that create real resources
 *   - turn an unmet dependency into a `skip`, never a silent omission
 *   - turn a check's own thrown error into a `fail`, never a propagated throw
 *
 * It does not print (design.md §4), does not interpret SDK errors (§8.1 —
 * that is `runner/errors.ts`), and does not correlate results into causes
 * (§4 — that is the diagnosis engine).
 */

import type { CheckRegistry } from "../checks/index.js";
import type { DoctorContext } from "../context.js";
import type { CheckResult, DoctorCheck } from "../types.js";

/** design.md §7: "a small bounded worker pool (default concurrency: 3)". */
export const DEFAULT_CONCURRENCY = 3;

export interface SchedulerOptions {
  /** Bound for `cheap`/`expensive` checks. `free` checks ignore this. */
  concurrency?: number;
  /** `--full`: include `expensive` checks. Off by default (§6.4). */
  full?: boolean;
}

/** A dependency was not satisfied, so the dependent cannot run. */
interface Blocked {
  /** The unmet dependency, immediately upstream. */
  blockedBy: string;
  /** The check that actually failed, at the head of the skip chain. */
  rootCause: string;
}

/**
 * Detects dependency cycles.
 *
 * Deferred here from module 3 deliberately: the registry validates identity
 * (ids are unique, dependencies exist), the scheduler validates structure.
 * A cycle can never become ready, so without this the run would either wait
 * forever or silently drop the checks involved.
 */
function assertNoCycles(checks: readonly DoctorCheck[]): void {
  const byId = new Map(checks.map((c) => [c.id, c]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const seen = state.get(id);
    if (seen === "done") return;
    if (seen === "visiting") {
      const from = stack.indexOf(id);
      const cycle = [...stack.slice(from), id].map((c) => `"${c}"`).join(" -> ");
      throw new Error(
        `Dependency cycle detected: ${cycle}. Every check in a cycle waits ` +
          `for another check in the same cycle, so none can ever become ` +
          `ready — the run would hang or drop them silently.`,
      );
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      // A dependency outside the run (filtered by `--full`) is not a cycle;
      // it is handled as a skip at readiness time.
      if (byId.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(id, "done");
  };

  for (const check of checks) visit(check.id);
}

/**
 * Rejects a graph the tier ordering cannot satisfy.
 *
 * §7 runs all `free` checks before the bounded pool starts. A `free` check that
 * depends on a `cheap` or `expensive` one therefore waits for something that
 * has not been scheduled yet, and the free phase deadlocks. None of the seven
 * locked checks does this, but nothing structurally prevents it — see finding
 * F38.
 */
function assertTierOrdering(checks: readonly DoctorCheck[]): void {
  const tierById = new Map(checks.map((c) => [c.id, c.costTier]));
  for (const check of checks) {
    if (check.costTier !== "free") continue;
    for (const dep of check.dependsOn ?? []) {
      const depTier = tierById.get(dep);
      if (depTier !== undefined && depTier !== "free") {
        throw new Error(
          `Check "${check.id}" is costTier "free" but depends on "${dep}", ` +
            `which is costTier "${depTier}". Free checks all run before the ` +
            `bounded pool starts (design.md §7), so this dependency could ` +
            `never be satisfied.`,
        );
      }
    }
  }
}

function skipResult(check: DoctorCheck, blocked: Blocked): CheckResult {
  const because =
    blocked.blockedBy === blocked.rootCause
      ? `"${blocked.rootCause}" did not pass`
      : `"${blocked.blockedBy}" was skipped, because "${blocked.rootCause}" did not pass`;

  return {
    id: check.id,
    status: "skip",
    // §7: skipped checks are never silently omitted, and the blocking check is
    // always named — a skip with no reason is indistinguishable from a bug.
    message: `skipped: ${because}`,
    durationMs: 0,
    evidence: {
      blockedBy: blocked.blockedBy,
      rootCause: blocked.rootCause,
    },
  };
}

/**
 * Runs one check, converting anything it throws into a `fail`.
 *
 * A check throwing is a defect in that check, but it is not a reason to abort
 * the whole run: the other six checks still have useful things to say. The
 * scheduler therefore never lets a check's exception escape.
 *
 * `durationMs` is measured here rather than trusted from the check, so it means
 * the same thing for every check and a check cannot forget to set it.
 */
async function runOne(
  check: DoctorCheck,
  ctx: DoctorContext,
): Promise<CheckResult> {
  const startedAt = ctx.clock.now();
  try {
    const result = await check.run(ctx);
    return { ...result, durationMs: ctx.clock.now() - startedAt };
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: check.id,
      status: "fail",
      message: `check "${check.id}" threw ${name}`,
      details: message,
      durationMs: ctx.clock.now() - startedAt,
      // Interpreting SDK errors is `runner/errors.ts`'s job (§8.1). This is
      // the last-resort net for a check that did not do that itself.
      evidence: { threw: name },
    };
  }
}

interface PhaseState {
  results: Map<string, CheckResult>;
  /** Head of each skip chain, so transitive skips can name the real cause. */
  rootCause: Map<string, string>;
  inRun: Set<string>;
}

type Readiness = { kind: "ready" } | { kind: "waiting" } | ({ kind: "blocked" } & Blocked);

function readiness(check: DoctorCheck, state: PhaseState): Readiness {
  for (const dep of check.dependsOn ?? []) {
    // Dropped from this run (e.g. an `expensive` dependency without `--full`).
    if (!state.inRun.has(dep)) {
      return { kind: "blocked", blockedBy: dep, rootCause: dep };
    }
    const result = state.results.get(dep);
    if (result === undefined) return { kind: "waiting" };
    if (result.status === "fail" || result.status === "skip") {
      return {
        kind: "blocked",
        blockedBy: dep,
        rootCause: state.rootCause.get(dep) ?? dep,
      };
    }
    // `pass` and `warn` both satisfy a dependency: a warning means "you are
    // exposed to a documented issue", not "this environment is unusable".
  }
  return { kind: "ready" };
}

async function runPhase(
  phase: readonly DoctorCheck[],
  concurrency: number,
  state: PhaseState,
  ctx: DoctorContext,
): Promise<void> {
  const pending = new Map(phase.map((c) => [c.id, c]));
  const inFlight = new Map<string, Promise<void>>();

  while (pending.size > 0 || inFlight.size > 0) {
    let progressed = false;

    for (const [id, check] of [...pending]) {
      if (inFlight.size >= concurrency) break;
      const status = readiness(check, state);
      if (status.kind === "waiting") continue;

      pending.delete(id);
      progressed = true;

      if (status.kind === "blocked") {
        state.results.set(id, skipResult(check, status));
        state.rootCause.set(id, status.rootCause);
        continue;
      }

      const running = runOne(check, ctx).then((result) => {
        state.results.set(id, result);
        inFlight.delete(id);
      });
      inFlight.set(id, running);
    }

    if (inFlight.size === 0 && !progressed) {
      // Unreachable: cycles and tier conflicts are rejected up front. Kept as
      // a loud failure rather than an infinite loop if that ever stops holding.
      throw new Error(
        `Scheduler deadlock: ${[...pending.keys()].map((id) => `"${id}"`).join(", ")} ` +
          `can never become ready. This indicates a scheduling bug.`,
      );
    }

    if (inFlight.size > 0) await Promise.race(inFlight.values());
  }
}

/**
 * Runs every registered check and returns one `CheckResult` each, in registry
 * order. Never throws for a check-level problem; throws only for a malformed
 * graph, which is a broken build rather than a diagnosable environment.
 */
export async function runChecks(
  registry: CheckRegistry,
  ctx: DoctorContext,
  options: SchedulerOptions = {},
): Promise<CheckResult[]> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (concurrency < 1) {
    throw new Error(`Scheduler concurrency must be at least 1, got ${concurrency}.`);
  }

  const all = registry.all();
  assertNoCycles(all);
  assertTierOrdering(all);

  // §6.4: expensive checks are opt-in. Excluded checks are absent from the
  // run entirely, and any dependent of one is skipped by `readiness`.
  const selected = all.filter((c) => c.costTier !== "expensive" || options.full === true);

  const state: PhaseState = {
    results: new Map(),
    rootCause: new Map(),
    inRun: new Set(selected.map((c) => c.id)),
  };

  // §7: free checks first, unbounded — they touch no network and create no
  // resources, so there is nothing to protect against.
  await runPhase(
    selected.filter((c) => c.costTier === "free"),
    Number.POSITIVE_INFINITY,
    state,
    ctx,
  );

  // Then everything that creates real resources, through the bounded pool.
  await runPhase(
    selected.filter((c) => c.costTier !== "free"),
    concurrency,
    state,
    ctx,
  );

  return selected.map((check) => {
    const result = state.results.get(check.id);
    if (result === undefined) {
      throw new Error(`Scheduler produced no result for "${check.id}". This is a bug.`);
    }
    return result;
  });
}
