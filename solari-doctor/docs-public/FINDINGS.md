# Findings

What was verified about the Solari SDKs while building `solari-doctor`, and how.

Every claim below carries the evidence actually obtained for it. Some are
settled by a live run; some are settled only for the part that could be
observed; one is contradicted by measurement. Status is given **per claim**
rather than as a blanket assurance, because the levels genuinely differ.

### Evidence levels

| Level | Name | What it proves |
|---|---|---|
| **L1** | Static | Read from source, type declarations, docs, or git history |
| **L2** | Unit | Deterministic logic, exercised by the test suite |
| **L3** | Integration | A real call against the real SDK |
| **L4** | Runtime | Actual process, resource, or lifecycle behaviour |

### Status labels

| Label | Meaning |
|---|---|
| **Confirmed** | Reproduced directly, at the level shown |
| **Confirmed, with a correction** | Reproduced, but the documented wording is imprecise |
| **Partially corroborated** | The observable part was reproduced; part of the claim was not |
| **Not confirmed** | Measurement disagrees with the documented claim |
| **Not reproducible here** | Out of reach of this tool; corroborated by other means, or not at all |

---

## Contents

**[1. Status at a glance](#1-status-at-a-glance)** — the five README gotchas · the three cited issues

**[2. SDK behaviour](#2-sdk-behaviour)** — [error model](#21-the-error-model-differs-by-product) · [the pre-0.1.3 hang](#22-the-pre-013-hang-and-its-boundary) · [`close()` vs `kill()`](#23-close-and-kill-on-a-sandbox) · [shell interpretation](#24-sandbox-commands-are-not-shell-interpreted) · [session liveness](#25-session-liveness) · [the SDK manifest](#26-the-sdk-manifest-cannot-be-imported)

**[3. The cited issues in detail](#3-the-cited-issues-in-detail)** — [#1](#31-issue-1--the-key-creation-modal) · [#25](#32-issue-25--sessions-dying-early) · [#27](#33-issue-27--the-missing-default-base-url)

**[4. A testing finding](#4-a-testing-finding)** — [fixtures must use the real classes](#41-fixtures-must-use-the-real-classes)

**[5. Open questions](#5-open-questions)** — [replay timing](#51-replay-timing) · [session `expiresAt`](#52-session-expiresat) · [`PROTOCOL.md`](#53-protocolmd)

**[6. A related but separate contribution](#6-a-related-but-separate-contribution)**

---

# 1. Status at a glance

## The five README gotchas

The cookbook's gotcha list is what this tool was built around. Each was tested
independently:

| # | Gotcha | Status | Evidence |
|:--|:--|:--|:--|
| 1 | `browser.close()` is enough to exit as of 0.1.3 | **Confirmed** | **L4** — A/B against real 0.1.2 and 0.1.3 installs: hung vs exited in ~3s |
| 2a | Recording is per session, not per account | **Confirmed** | **L3** — a parallel control session without `recording: true` 404'd for 240s while the recorded one produced a replay |
| 2b | "poll for ~30s before giving up" | **Not confirmed** — measurement disagrees | **L3** — three runs: 404 through 60s, replay at 8.2s, 404 through 46s. See [§5.1](#51-replay-timing) |
| 3 | Sandbox commands are not shell-interpreted | **Confirmed, with a correction** | **L3** — the raw form *throws `ActionError`*; it does not exit non-zero |
| 4 | `kill()`, not `close()`, ends a VM | **Confirmed, with a correction** | **L4** — termination shows up as a **404**, not as a state transition |
| 5 | `timeoutMs` is a rolling idle window | **Partially observed** | **L3** — a sandbox's `expiresAt` advanced after activity. The window was never driven to expiry, and no check depends on it |

> Gotcha 5 is in unresolved tension with issue #25, which reports sessions
> ending long before any documented deadline. Neither source was measured
> against the other; the 10-minute observation that would settle it is outside
> this project's scope.

## The three cited issues

Three open issues are referenced in check output. They were **not** verified to
the same degree, and the checks are worded to match. Detail in
[§3](#3-the-cited-issues-in-detail).

| Issue | Subject | Status here |
|:--|:--|:--|
| [**#1**](https://github.com/solari-sdk/solari-cookbook/issues/1) | The key-creation modal loses the secret | **Partially corroborated** — the UI event is unobservable from a CLI; the downstream failures were reproduced |
| [**#25**](https://github.com/solari-sdk/solari-cookbook/issues/25) | Sessions end at ~10 min while the status endpoint says `active` | **Partially corroborated** — all three liveness signals confirmed live; the 10-minute timeline deliberately not reproduced |
| [**#27**](https://github.com/solari-sdk/solari-cookbook/issues/27) | Go examples need an explicit `-base-url` | **Not reproducible here** — it is a Go issue. Corroborated cross-language instead |

---

# 2. SDK behaviour

## 2.1 The error model differs by product

`@solarisdk/browser` exports exactly **one** error class:

```ts
class SolariError extends Error {
  readonly status?: number;
  readonly cause?: unknown;
  readonly code?: SolariErrorCode | string;
}
```

`@solarisdk/core` — re-exported by `@solarisdk/sdk` and `@solarisdk/sandbox` —
exports a **full hierarchy** instead:

```
SolariError
├── GatewayError
│   ├── AuthError
│   ├── PlanError
│   ├── ConcurrencyLimitError
│   └── NoCapacityError
├── ActionError
├── TimeoutError
└── ConnectionError
```

The same split exists in the Go SDKs, so it is a property of the **products**
rather than of TypeScript.

**Two consequences worth knowing before writing error handling:**

1. **The two `SolariError` classes are different classes.** A browser error is
   not `instanceof` the core one, and vice versa. A cross-package `instanceof`
   returns `false` silently — no crash, no type error, just an error that never
   matches.
2. **`code` is `undefined` for a 401 on both SDKs.** Authentication must be
   detected from `status === 401`; matching auth on an error code never fires.
   *(**L3** — verified with a deliberately invalid key against both clients.)*

## 2.2 The pre-0.1.3 hang, and its boundary

`@solarisdk/browser` keeps a loopback proxy open for connection retries. Before
0.1.3 that listener held Node's event loop open, so a script that called
`browser.close()` without also calling `solari.close()` printed its output and
then hung. **0.1.3 unrefs the listener.**

Measured directly — same script, same account, one variable:

| Version | Calls | Result |
|:--|:--|:--|
| **0.1.2** | `browser.close()` only, no `solari.close()` | **Hung** — killed at 75s |
| **0.1.3** | `browser.close()` only, no `solari.close()` | **Exited in ~3s** |

*(**L4**.)*

This is why `sdk-version` and `browser-lifecycle` are **separate checks**: a
version read shows *exposure*, a lifecycle observation shows a *symptom*, and
only together do they identify the documented bug.

> **A stale comment in the cookbook.** The README gotcha was corrected when
> 0.1.3 shipped, but the TypeScript examples still told readers `solari.close()`
> was required. Fixed in a separate PR — see [§6](#6-a-related-but-separate-contribution).

## 2.3 `close()` and `kill()` on a sandbox

`close()` is **synchronous** and drops only the local control channel.
`kill()` destroys the VM and is **idempotent**.

Verified live:

| Step | `sandboxes.get()` reports |
|:--|:--|
| After `close()` | `state: "running"` — the VM is still there |
| After `kill()` | **404** — the record is gone |

*(**L4**.)* Termination is confirmed by the record disappearing, **not** by a
state transition.

The response carries **no billing field of any kind**, which is why the check's
wording stops at *"may result in continued resource consumption/billing"* and
never claims a cost was incurred.

## 2.4 Sandbox commands are not shell-interpreted

| Call | Outcome |
|:--|:--|
| `run("ls -la")` | **Throws `ActionError`** — it does not merely exit non-zero |
| `run("ls", { args: ["-la", "/tmp"] })` | Succeeds |
| `run("sh", { args: ["-c", "..."] })` | The way to get pipes, globs or redirection |

*(**L3**.)*

## 2.5 Session liveness

All three signals issue #25 names as reliable were confirmed against a session
released server-side *(**L4**)*:

1. `isConnected()` flipped to `false`
2. The `disconnected` event fired
3. A subsequent page call threw

> **The thrown class arrived as `TargetClosedError2`** — a bundler-renamed
> Playwright-family error from `patchright-core`, not a Solari export. Matching
> on that name would break on any rebuild, so `isConnected()` is the primary
> signal and the class name is recorded as **evidence only**.

## 2.6 The SDK manifest cannot be imported

`@solarisdk/browser/package.json` is **not an exported subpath**, so importing
it throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The package is also **ESM-only** —
its `exports` map declares `types` and `import` with no `require` condition — so
CommonJS cannot load it at all.

`sdk-version` therefore reads the manifest **from the filesystem, anchored at
the user's project root**. That anchoring matters: `solari-doctor` depends on
the same package, so module resolution would report *its own* version and the
check would always pass.

---

# 3. The cited issues in detail

## 3.1 Issue #1 — the key-creation modal

> The API key modal at `console.getsolari.com` reveals the secret once, and it
> is easy to lose.

**Status: partially corroborated.**

The console UI event is not observable from a CLI and was **never reproduced**.
What *was* reproduced live is the downstream failure:

- A truncated or malformed key producing a **401**.
- A key broken by a pasted line break being **rejected before the request is
  even sent** — `fetch` refuses the header, so the key never reaches the wire.

## 3.2 Issue #25 — sessions dying early

> Browser sessions end at ~10 min while `GET /sessions/:id` still reports
> `active`.

**Status: partially corroborated.**

| Part of the claim | Result |
|:--|:--|
| The `disconnected` event is reliable | **Confirmed (L4)** |
| `isConnected() === false` is reliable | **Confirmed (L4)** |
| A thrown error on the next page call is reliable | **Confirmed (L4)** |
| Sessions die at ~10 minutes | **Not reproduced** — measuring it needs a 10-minute idle run, outside this project's scope by design |

## 3.3 Issue #27 — the missing default base URL

> Go examples fail without an explicit `-base-url`; the standalone Sandbox Go
> SDK has no default.

**Status: not reproducible here** — it is a Go issue and this is a TypeScript
tool, so no check covers it.

### It has a TypeScript analogue, and that analogue decided a design choice

The same shape exists in the TypeScript packages:

| Package | `baseUrl` |
|:--|:--|
| `@solarisdk/sdk` → `SolariClient` | Defaults to `https://api.getsolari.com` |
| `@solarisdk/sandbox` → `SandboxClient` | Declared `baseUrl: string` — **required, no `?`** — with no default |

*(**L1**, from the published `.d.ts`. The cookbook's own TypeScript example
carries a comment saying as much.)*

This is the same defect the Go issue describes, in a second language — evidence
that it is a property of the **standalone packages** rather than of one SDK.

**It settled a decision here:** the sandbox checks use `SolariClient` from
`@solarisdk/sdk` rather than the standalone package. Choosing the standalone one
would have forced `solari-doctor` to invent a `baseUrl` of its own — hardcoding
a gateway address into a tool whose entire job is diagnosing environment
problems.

---

# 4. A testing finding

## 4.1 Fixtures must use the real classes

A test fixture that scripted a 404 as `new Error()` with a `name` and `status`
assigned to it **passed the check's own `.status` read** — and was then
classified as an *unrecognised* error by the shared mapper, which dispatches on
`instanceof`.

Matching is by identity. A fixture that merely *resembles* an SDK error tests a
different program than the one that ships.

---

# 5. Open questions

None of these block the tool. All are recorded rather than resolved.

## 5.1 Replay timing

Three live runs of the recording cycle disagree:

| Run | Result |
|:--|:--|
| 1 | No replay within **60s** |
| 2 | Replay at **8.2s** |
| 3 | No replay within **46s** |

Solari's own figures disagree too:

| Source | Figure |
|:--|:--|
| SDK doc comment on `getReplayUrl` | *"Available ~1-3s after `releaseAndWait`"* |
| Cookbook README, gotcha 2 | *"poll for ~30s before giving up"* |

Two of three runs produced **no replay at all**, so the open question is not
*"how long does the upload take"* but *"does a replay reliably appear"*. That is
a question for Solari.

`recording-lifecycle` therefore reports a timeout as **inconclusive**, states
Solari's documented figure and our own polling ceiling as **separate numbers**,
and does not claim a guarantee was breached.

## 5.2 Session `expiresAt`

| Source | Value |
|:--|:--|
| Issue #25, Starter tier | `createdAt + 5h` |
| Measured here | `createdAt + 1h` |

The plan tier of this account is unknown, so the two are not necessarily in
conflict and the discrepancy is **unresolved**.

It changes nothing in the tool — `session-liveness` is structural and never
trusts `expiresAt` or the status endpoint — but it is one more reason not to.

## 5.3 `PROTOCOL.md`

Three SDK READMEs reference an authoritative protocol contract —
`sdk/PROTOCOL.md` from the Rust SDK, `../PROTOCOL.md` from the Go one — that is
**not present in any public repository**, and the `sdk/` directory they point at
has no public counterpart.

Cross-SDK protocol conformance is therefore out of scope, and this project makes
no claim about wire compatibility.

**Three questions for the maintainers, whenever convenient:**

1. Does `PROTOCOL.md` exist in a private or internal location?
2. Is it available through another repository or path?
3. Or is cross-SDK conformance intentionally outside the public surface?

---

# 6. A related but separate contribution

The stale close-guidance in the cookbook's TypeScript examples ([§2.2](#22-the-pre-013-hang-and-its-boundary))
is fixed on the **`fix-browser-close-example`** branch, proposed to upstream as
its own pull request.

It is a documentation fix that this work happened to surface — **not part of
this project**.
