/**
 * Diagnosis rules — data, not logic (design.md §15.1).
 *
 * Separated from the engine because rules change often and the engine rarely.
 * Every rule below is traceable to something verified: a cookbook gotcha, a
 * GitHub issue, or a measurement recorded in `docs/findings.md`. A rule that
 * cannot cite one does not belong here — design.md §3 principle 5.
 *
 * Rules referencing checks that do not exist yet simply never match, so this
 * file grows alongside modules 9-13 rather than waiting for them.
 */

import type { DiagnosisRule } from "./engine.js";

/**
 * The example design.md §4 gives, and the reason the diagnosis layer exists.
 *
 * `sdk-version` reports exposure (a static version read); `browser-lifecycle`
 * reports an observation (the process did not exit). Neither is conclusive
 * alone. Together they are the documented pre-0.1.3 hang, measured at L4:
 * 0.1.2 was still hung at 75s where 0.1.3 exited in ~3s (finding F27).
 */
const KNOWN_PRE_013_HANG: DiagnosisRule = {
  id: "known-pre-0.1.3-hang",
  reads: ["sdk-version", "browser-lifecycle"],
  matches: (r) => r.is("sdk-version", "warn") && r.is("browser-lifecycle", "fail"),
  cause:
    "the installed @solarisdk/browser is older than 0.1.3, and a process that " +
    "opened a session did not exit — the documented loopback-proxy hang",
  confidence: "high",
  remediation:
    "Upgrade to @solarisdk/browser 0.1.3 or later, where the retry listener is " +
    "unref'd and browser.close() alone is enough to exit. Until then, call " +
    "await solari.close() in a finally block.",
  issueRef: "solari-cookbook#README-gotcha-1",
};

/**
 * The same observation on a version where the bug is supposed to be fixed.
 *
 * Deliberately *not* high confidence. F18 established that 0.1.3 exits cleanly,
 * so a hang here is something this project has not seen — which makes it worth
 * reporting and worth being honest about not understanding.
 */
const UNEXPECTED_HANG_ON_FIXED_VERSION: DiagnosisRule = {
  id: "unexpected-hang-on-fixed-version",
  reads: ["sdk-version", "browser-lifecycle"],
  matches: (r) => r.is("sdk-version", "pass") && r.is("browser-lifecycle", "fail"),
  cause:
    "a process that opened a session did not exit, on an SDK version where the " +
    "documented hang is fixed — this is not the known bug",
  confidence: "low",
  remediation:
    "The documented cause does not apply at this version. Something else is " +
    "holding the event loop open: another open handle, a timer, or a regression " +
    "in the SDK. Re-run with --report and check what else the process has open.",
};

/**
 * Turns a cascade of skips into one actionable statement.
 *
 * Every resource-creating check depends on `auth`, so a failed key produces one
 * real failure and five skips. The skips each name the blocker (design.md §7),
 * but the run as a whole reads better with a single cause at the top.
 */
const AUTH_BLOCKS_EVERYTHING: DiagnosisRule = {
  id: "auth-blocks-everything",
  reads: ["auth"],
  matches: (r) => r.is("auth", "fail"),
  cause: "authentication failed, so no check that needs the API could run",
  remediation:
    "Fix SOLARI_API_KEY first; the remaining checks cannot report anything " +
    "useful until it authenticates. Note that the key-creation modal on " +
    "console.getsolari.com closes immediately after the first key is generated, " +
    "so a truncated or never-copied key is a common cause.",
  confidence: "high",
  issueRef: "solari-cookbook#1",
};

/**
 * The one check with a resource consequence rather than a developer-time one.
 *
 * The claim is deliberately limited to what the API proves: `sandboxes.get()`
 * reported `state: "running"` after `close()` (F19, L4), and the response
 * carries no billing field at all. design.md §6.6 locks this phrasing.
 */
const SANDBOX_LEFT_RUNNING: DiagnosisRule = {
  id: "sandbox-left-running",
  reads: ["sandbox-cleanup"],
  matches: (r) => r.is("sandbox-cleanup", "fail"),
  cause:
    "a sandbox remained running after close(); close() drops only the local " +
    "control channel",
  remediation:
    "Call kill() to destroy the VM. close() alone leaves it running until its " +
    "idle timeout, which may result in continued resource consumption or " +
    "billing until then.",
  confidence: "high",
  issueRef: "solari-cookbook#README-gotcha-4",
};

/** Evaluated in this order; the engine preserves it. */
export const DIAGNOSIS_RULES: readonly DiagnosisRule[] = [
  AUTH_BLOCKS_EVERYTHING,
  KNOWN_PRE_013_HANG,
  UNEXPECTED_HANG_ON_FIXED_VERSION,
  SANDBOX_LEFT_RUNNING,
];
