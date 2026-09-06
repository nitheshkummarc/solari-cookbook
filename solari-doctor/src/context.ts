/**
 * DoctorContext — design.md §5.
 *
 * Every field here was derived from what the seven checks actually require
 * (design.md §5's derivation table), not designed up front. Deliberately
 * absent, and each for a stated reason:
 *
 *   - no logger              checks never print (design.md §4)
 *   - no `full` flag         the scheduler gates by costTier (design.md §7)
 *   - no desktop/template/volume clients   no locked check touches them
 *   - no AbortSignal         not required by anything in §6
 *   - no child-harness paths §5 marks these "provisional, not yet earned";
 *                            decided when browser-lifecycle actually needs them
 */

import { Solari, type SolariRegion } from "@solarisdk/browser";
import { SolariClient } from "@solarisdk/sdk";

/** Injected so poll and deadline logic is testable without real waits. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Timing constants in one place, each traceable to evidence. */
export interface Deadlines {
  /** `browser-lifecycle`: the child process must exit within this. */
  childExitMs: number;
  /** `recording-lifecycle`: documented ~30s plus our margin. */
  replayPollMs: number;
}

export interface DoctorContext {
  /** Raw key. Never logged, never placed in `evidence`, never in `--report`. */
  readonly apiKey: string | undefined;

  /**
   * Root to resolve the *user's* installed SDK from. Defaults to
   * `process.cwd()`.
   *
   * This is not cosmetic. solari-doctor depends on `@solarisdk/browser`
   * itself, so resolving the package through its own module graph would report
   * the doctor's version rather than the user's — a check that always passes
   * and tells the user nothing (findings F35, §19.2).
   */
  readonly projectRoot: string;

  /** Undefined means the SDK defaults (region `"us-west"`). */
  readonly region?: SolariRegion;
  /** Undefined means the SDK default (`https://api.getsolari.com`). */
  readonly baseUrl?: string;

  /**
   * Lazily constructed and memoised. A default run whose `auth` check fails
   * must never pay for a browser client it will not use.
   */
  browser(): Solari;
  sandbox(): SolariClient;

  readonly clock: Clock;
  readonly deadlines: Deadlines;
}

export interface DoctorContextOptions {
  apiKey?: string | undefined;
  projectRoot?: string | undefined;
  region?: SolariRegion | undefined;
  baseUrl?: string | undefined;
  clock?: Clock | undefined;
  deadlines?: Partial<Deadlines> | undefined;
}

/**
 * `browser-lifecycle` observes whether a child process exits on its own. 3s
 * matches the `deadlineMs` in design.md §5's own evidence example, and sits
 * well clear of the ~3s a healthy 0.1.3 close-and-exit actually took (F27).
 */
const DEFAULT_CHILD_EXIT_MS = 3_000;

/**
 * The cookbook README documents "poll for ~30s before giving up". That is the
 * only figure presented as a Solari fact (design.md §6.4); the extra 15s is our
 * engineering margin and must be described that way in any output.
 *
 * Note A6 is still open: one measured run had a replay at 8.2s, another saw no
 * replay within 60s (finding F33). This value is a starting point, not a
 * verified window.
 */
const DEFAULT_REPLAY_POLL_MS = 45_000;

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

function requireApiKey(apiKey: string | undefined, what: string): string {
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      `Cannot construct the ${what} client: SOLARI_API_KEY is not set. ` +
        `The auth check reports this condition; dependent checks should be ` +
        `skipped rather than reaching this point.`,
    );
  }
  return apiKey;
}

export function createDoctorContext(
  options: DoctorContextOptions = {},
): DoctorContext {
  const apiKey = options.apiKey;
  const projectRoot = options.projectRoot ?? process.cwd();
  const clock = options.clock ?? systemClock;

  const deadlines: Deadlines = {
    childExitMs: options.deadlines?.childExitMs ?? DEFAULT_CHILD_EXIT_MS,
    replayPollMs: options.deadlines?.replayPollMs ?? DEFAULT_REPLAY_POLL_MS,
  };

  // Memoisation cells. Nothing is constructed until the accessor is called.
  let browserClient: Solari | undefined;
  let sandboxClient: SolariClient | undefined;

  return {
    apiKey,
    projectRoot,
    // `exactOptionalPropertyTypes` is on: an absent option must stay absent
    // rather than becoming an explicit `undefined`.
    ...(options.region !== undefined ? { region: options.region } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    clock,
    deadlines,

    browser(): Solari {
      browserClient ??= new Solari({
        apiKey: requireApiKey(apiKey, "browser"),
        ...(options.region !== undefined ? { region: options.region } : {}),
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      });
      return browserClient;
    },

    sandbox(): SolariClient {
      // SolariClient, not the standalone SandboxClient: `baseUrl` is optional
      // here and required there, so the standalone client would force this
      // tool to hardcode a gateway URL — the same defect class as issue #27
      // (decision C8, design.md §6.5).
      sandboxClient ??= new SolariClient({
        apiKey: requireApiKey(apiKey, "sandbox"),
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      });
      return sandboxClient;
    },
  };
}
