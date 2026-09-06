# Findings

What was verified about the Solari SDKs while building solari-doctor, and how.

Everything below was confirmed from a primary source — the published `.d.ts`
files, the cookbook's git history, or a live run against the API. Where a claim
could not be verified, it says so.

**Evidence levels.** L1 static (source, types, docs, history) · L2 unit ·
L3 integration against the real SDK · L4 runtime behaviour of a real process.

---

## The SDK error model differs by product

`@solarisdk/browser` exports exactly one error class:

```ts
class SolariError extends Error {
  readonly status?: number;
  readonly cause?: unknown;
  readonly code?: SolariErrorCode | string;
}
```

`@solarisdk/core` — re-exported by `@solarisdk/sdk` and `@solarisdk/sandbox` —
exports a full hierarchy instead: `AuthError`, `PlanError`,
`ConcurrencyLimitError` and `NoCapacityError` all extend `GatewayError`, which
extends `SolariError`, alongside `ActionError`, `TimeoutError` and
`ConnectionError`.

The same split exists in the Go SDKs, so it is a property of the products rather
than of TypeScript.

Two consequences worth knowing before writing error handling:

- **The two `SolariError` classes are different classes.** A browser error is
  not `instanceof` the core one, and vice versa. A cross-package `instanceof`
  returns `false` silently — no crash, no type error, just an error that never
  matches.
- **`code` is `undefined` for a 401 on both SDKs.** Authentication must be
  detected from `status === 401`. Matching auth on an error code never fires.
  *(L3: verified with a deliberately invalid key against both clients.)*

## The pre-0.1.3 hang, and its boundary

`@solarisdk/browser` keeps a loopback proxy open for connection retries. Before
0.1.3 that listener held Node's event loop open, so a script that called
`browser.close()` without also calling `solari.close()` printed its output and
then hung. 0.1.3 unrefs the listener.

Measured directly, same script, same account, one variable:

| Version | `browser.close()` only | Result |
|---|---|---|
| 0.1.2 | no `solari.close()` | **hung** — killed at 75s |
| 0.1.3 | no `solari.close()` | **exited in ~3s** |

*(L4.)* This is why `sdk-version` and `browser-lifecycle` are separate checks: a
version read shows exposure, a lifecycle observation shows a symptom, and only
together do they identify the documented bug.

**A stale comment in the cookbook.** The README gotcha was corrected when 0.1.3
shipped, but the TypeScript examples still told readers `solari.close()` was
required. This was fixed in a separate PR (see below).

## `close()` and `kill()` on a sandbox

`close()` is **synchronous** and drops only the local control channel. `kill()`
destroys the VM and is idempotent.

Verified live: after `close()`, `sandboxes.get()` reported `state: "running"`;
after `kill()`, the same call returned **404** — the record is gone, which is how
termination is confirmed rather than by a state transition. *(L4.)*

The response carries no billing field of any kind, which is why the check's
wording stops at "may result in continued resource consumption/billing".

## Sandbox commands are not shell-interpreted

`run("ls -la")` as a raw string **throws `ActionError`** — it does not merely
exit non-zero. `run("ls", { args: ["-la", "/tmp"] })` succeeds. For pipes, globs
or redirection, invoke a shell explicitly: `run("sh", { args: ["-c", "..."] })`.
*(L3.)*

## Session liveness

All three signals issue #25 names as reliable were confirmed against a session
released server-side: `isConnected()` flipped to `false`, the `disconnected`
event fired, and a subsequent page call threw. *(L4.)*

The thrown class arrived as **`TargetClosedError2`** — a bundler-renamed
Playwright-family error from `patchright-core`, not a Solari export. Matching on
that name would break on any rebuild, so `isConnected()` is the primary signal
and the class name is recorded as evidence only.

## The SDK manifest cannot be imported

`@solarisdk/browser/package.json` is not an exported subpath, so importing it
throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The package is also ESM-only — its
`exports` map declares `types` and `import` with no `require` condition — so
CommonJS cannot load it at all.

`sdk-version` therefore reads the manifest from the filesystem, anchored at the
user's project root. That anchoring matters: solari-doctor depends on the same
package, so module resolution would report *its own* version and the check would
always pass.

## Fixtures must use the real classes

A test fixture that scripted a 404 as `new Error()` with a `name` and `status`
assigned to it passed the check's own `.status` read — and was then classified as
an unrecognised error by the shared mapper, which dispatches on `instanceof`.

Matching is by identity, so a fixture that merely resembles an SDK error tests a
different program than the one that ships.

---

## Open, and not blocking

**Replay timing.** Three live runs of the recording cycle disagree: no replay
within 60s, a replay at 8.2s, and no replay within 46s. Solari's own figures
disagree too — the SDK's doc comment says ~1-3s after release, the cookbook
README says ~30s.

Two of three runs produced no replay at all, so the open question is not "how
long does the upload take" but "does a replay reliably appear". That is a
question for Solari. `recording-lifecycle` therefore reports a timeout as
**inconclusive**, states Solari's documented figure and our own polling ceiling
as separate numbers, and does not claim a guarantee was breached.

**`PROTOCOL.md`.** Three SDK READMEs reference an authoritative protocol
contract — `sdk/PROTOCOL.md` from the Rust SDK, `../PROTOCOL.md` from the Go
one — that is not present in any public repository, and the `sdk/` directory
they point at has no public counterpart. Cross-SDK protocol conformance is
therefore out of scope, and this project makes no claim about wire compatibility.

Three questions for the maintainers, whenever convenient:

1. Does `PROTOCOL.md` exist in a private or internal location?
2. Is it available through another repository or path?
3. Or is cross-SDK conformance intentionally outside the public surface?

**A related but separate contribution.** The stale close-guidance in the
cookbook's TypeScript examples is fixed on the `fix-browser-close-example`
branch, proposed to upstream as its own pull request. It is a documentation fix
that this work happened to surface — not part of this project.
