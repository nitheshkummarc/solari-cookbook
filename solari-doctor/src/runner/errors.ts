/**
 * Shared SDK error mapping — design.md §8 and §8.1.
 *
 * One error path, used identically everywhere. Checks pass a caught error in
 * and get a result shape back; no check writes its own `instanceof` ladder or
 * its own wording for a condition another check can also hit.
 *
 * This module owns the `instanceof` ordering, and that ordering is the whole
 * point: `AuthError extends GatewayError extends SolariError`, so testing the
 * parent first silently swallows every 401. That failure compiles, passes a
 * typecheck, and produces a plausible-looking wrong answer — which is why the
 * ordering is asserted by tests rather than trusted to review.
 *
 * Security boundary (design.md §9): nothing leaving this module contains the
 * raw error object, a stack trace, or an API key. Every message is sanitised.
 */

import { SolariError as BrowserSolariError } from "@solarisdk/browser";
import {
  ActionError,
  AuthError,
  ConcurrencyLimitError,
  ConnectionError,
  GatewayError,
  NoCapacityError,
  PlanError,
  SolariError as CoreSolariError,
  TimeoutError,
} from "@solarisdk/sdk";

/**
 * Which SDK the caller was talking to.
 *
 * This is not cosmetic. `@solarisdk/browser` and `@solarisdk/core` each export
 * their own `SolariError` class, and they are **not** the same class — a
 * browser error is not `instanceof` the core one, and vice versa (finding F39,
 * verified at runtime). Passing the wrong product would make every check fall
 * through to the unrecognised branch while still looking like it worked.
 */
export type SdkProduct = "browser" | "core";

/** Report-safe facts about a mapped error. Never the error object itself. */
export interface MappedErrorEvidence {
  product: SdkProduct;
  /** Constructor name only — useful, and cannot carry a payload. */
  errorClass: string;
  /** False when nothing matched; the result is still structured. */
  recognized: boolean;
  /** HTTP status, where the SDK exposes one. */
  status?: number;
  /** Gateway code, where the SDK exposes one. Never present for a 401 (F28). */
  code?: string;
  /**
   * Set when the error came from a different SDK than the caller declared.
   * Surfacing this turns a silent mis-import into a visible defect.
   */
  productMismatch?: boolean;
  /** The SDK's own message, with any key-shaped token removed. */
  sanitizedMessage: string;
}

export interface MappedError {
  message: string;
  remediation: string;
  evidence: MappedErrorEvidence;
}

/**
 * Any `slr_live_` / `slr_test_` token is stripped before a message is stored.
 *
 * No observed SDK message has contained a key (F28), so this is defence in
 * depth rather than a known leak — but §9's rule is that the key must never
 * reach a report, and "we checked once and it was fine" is not a mechanism.
 */
const API_KEY_PATTERN = /slr_(?:live|test)_[A-Za-z0-9_-]+/g;
const MAX_MESSAGE_LENGTH = 300;

export function sanitizeErrorMessage(message: string): string {
  return message.replace(API_KEY_PATTERN, "slr_***redacted***").slice(0, MAX_MESSAGE_LENGTH);
}

interface Mapping {
  message: string;
  remediation: string;
}

const UNRECOGNISED: Mapping = {
  message: "an unrecognised error was thrown",
  remediation:
    "This is not an error shape solari-doctor knows about. Re-run with --report " +
    "and include the error class and status; the check itself may need updating.",
};

const AUTH: Mapping = {
  message: "authentication was rejected (HTTP 401)",
  remediation:
    "Check that SOLARI_API_KEY is set and was copied in full. The key-creation " +
    "modal on console.getsolari.com closes immediately after the first key is " +
    "generated (cookbook issue #1), so a truncated or never-copied key is a " +
    "common cause. Generating a second key leaves the modal open.",
};

const FEATURE_REQUIRES_PLAN: Mapping = {
  message: "this feature is not available on the current plan (HTTP 402)",
  remediation: "Check the plan tier at console.getsolari.com; this operation needs a higher one.",
};

const PLAN_LIMIT: Mapping = {
  message: "a plan limit has been reached (HTTP 402)",
  remediation:
    "A quota on the current plan is exhausted, not a per-request limit. Waiting " +
    "will not clear it; check usage at console.getsolari.com.",
};

const CONCURRENCY_LIMIT: Mapping = {
  message: "too many sessions are already running (HTTP 429)",
  remediation:
    "Release existing sessions before starting more. Note that browser.close() " +
    "releases a browser session, but sandbox close() does not stop a VM — that " +
    "needs kill() (cookbook gotcha 4), so leaked sandboxes can hold slots.",
};

const NO_CAPACITY: Mapping = {
  message: "no host was available to serve the request (HTTP 503)",
  remediation:
    "A capacity problem on Solari's side, not a configuration problem. Retry " +
    "shortly; nothing local needs changing.",
};

const BROWSER_UNHEALTHY: Mapping = {
  message: "the browser session was reported unhealthy",
  remediation:
    "The session exists but its browser is not serving requests. Release it and " +
    "launch a new one rather than retrying against the same session.",
};

const INVALID_SESSION: Mapping = {
  message: "the session id was not recognised",
  remediation:
    "The session has been released or never existed. Note that GET /sessions/:id " +
    "can still report a dead session as active (cookbook issue #25), so derive " +
    "liveness from the connection — isConnected() — rather than from status.",
};

const GATEWAY: Mapping = {
  message: "the gateway returned an error response",
  remediation: "A non-2xx response that has no more specific meaning. The status is in evidence.",
};

const ACTION_FAILED: Mapping = {
  message: "a remote action returned a failure",
  remediation:
    "The RPC reached the sandbox and was refused. For commands, the usual cause " +
    "is passing a whole command line as the binary name — argv belongs in `args`, " +
    "or run a shell explicitly with sh -c (cookbook gotcha 3).",
};

const TIMED_OUT: Mapping = {
  message: "a remote call exceeded its timeout",
  remediation:
    "The call did not return within the per-call timeout. Note that timeoutMs on " +
    "a sandbox is a rolling idle window, not a hard deadline (cookbook gotcha 5).",
};

const CONNECTION_LOST: Mapping = {
  message: "the control connection is not open",
  remediation:
    "The WebSocket control channel never connected or has closed. For sandboxes, " +
    "close() drops this channel locally while the VM keeps running — reconnect, " +
    "or use kill() if the intent was to stop it.",
};

/** Browser SDK codes (F13). No auth member exists — 401 is status-only (F28). */
const BROWSER_CODE_MAPPINGS: Readonly<Record<string, Mapping>> = {
  FeatureRequiresPlan: FEATURE_REQUIRES_PLAN,
  PlanLimitExceeded: PLAN_LIMIT,
  ConcurrencyLimitExceeded: CONCURRENCY_LIMIT,
  BrowserUnhealthy: BROWSER_UNHEALTHY,
  InvalidSessionId: INVALID_SESSION,
};

function errorClassName(error: unknown): string {
  if (error instanceof Error) return error.constructor.name;
  return typeof error;
}

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Model A — `@solarisdk/browser`.
 *
 * One error class. `status` is checked before `code` because a 401 carries no
 * code at all (F28): matching auth on `.code` would never fire.
 */
function mapBrowser(error: unknown): { mapping: Mapping; status?: number; code?: string; recognized: boolean } {
  if (!(error instanceof BrowserSolariError)) {
    return { mapping: UNRECOGNISED, recognized: false };
  }

  const { status, code } = error;
  const base = {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
  };

  if (status === 401) return { ...base, mapping: AUTH, recognized: true };
  if (code !== undefined) {
    const byCode = BROWSER_CODE_MAPPINGS[code];
    if (byCode !== undefined) return { ...base, mapping: byCode, recognized: true };
  }
  if (status !== undefined) return { ...base, mapping: GATEWAY, recognized: true };
  return { ...base, mapping: UNRECOGNISED, recognized: false };
}

/**
 * Model B — `@solarisdk/core`, re-exported by `@solarisdk/sdk`.
 *
 * ORDER IS LOAD-BEARING. The four gateway subclasses are tested before
 * `GatewayError`, and everything is tested before the bare `SolariError`.
 * Reversing any pair here compiles cleanly and silently produces the wrong
 * message — see the ordering tests.
 */
function mapCore(error: unknown): { mapping: Mapping; status?: number; code?: string; recognized: boolean } {
  const status = error instanceof GatewayError ? error.status : undefined;
  const code =
    error instanceof GatewayError || error instanceof ActionError ? error.code : undefined;
  const base = {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
  };

  // --- most-derived first ---------------------------------------------------
  if (error instanceof AuthError) return { ...base, mapping: AUTH, recognized: true };
  if (error instanceof PlanError) return { ...base, mapping: FEATURE_REQUIRES_PLAN, recognized: true };
  if (error instanceof ConcurrencyLimitError) return { ...base, mapping: CONCURRENCY_LIMIT, recognized: true };
  if (error instanceof NoCapacityError) return { ...base, mapping: NO_CAPACITY, recognized: true };
  // --- then their common parent ---------------------------------------------
  if (error instanceof GatewayError) return { ...base, mapping: GATEWAY, recognized: true };
  // --- siblings of GatewayError, all extending SolariError directly ---------
  if (error instanceof ActionError) return { ...base, mapping: ACTION_FAILED, recognized: true };
  if (error instanceof TimeoutError) return { ...base, mapping: TIMED_OUT, recognized: true };
  if (error instanceof ConnectionError) return { ...base, mapping: CONNECTION_LOST, recognized: true };
  // --- finally the root -----------------------------------------------------
  if (error instanceof CoreSolariError) return { ...base, mapping: UNRECOGNISED, recognized: false };

  return { mapping: UNRECOGNISED, recognized: false };
}

/**
 * Maps any caught error to a message, a remediation, and report-safe evidence.
 *
 * Never throws: an unrecognised shape still returns a structured result. A
 * check must never crash the scheduler because an error was not what it
 * expected.
 */
export function mapSdkError(error: unknown, product: SdkProduct): MappedError {
  const mapped = product === "browser" ? mapBrowser(error) : mapCore(error);

  // Declared one SDK, caught an error from the other. Not fatal — the result
  // is still structured — but it means a check imported the wrong client, and
  // that must not stay invisible.
  const mismatched =
    (product === "browser" && error instanceof CoreSolariError) ||
    (product === "core" && error instanceof BrowserSolariError);

  return {
    message: mapped.mapping.message,
    remediation: mapped.mapping.remediation,
    evidence: {
      product,
      errorClass: errorClassName(error),
      recognized: mapped.recognized,
      ...(mapped.status !== undefined ? { status: mapped.status } : {}),
      ...(mapped.code !== undefined ? { code: mapped.code } : {}),
      ...(mismatched ? { productMismatch: true } : {}),
      sanitizedMessage: sanitizeErrorMessage(rawMessage(error)),
    },
  };
}
