# solari-doctor — design

A deterministic CLI that checks a developer's environment against a fixed set of
documented Solari failure modes, and reports for each one **what is wrong, why,
and what to do about it**.

---

## Contents

**[1. The problem](#1-the-problem)**

**[2. Principles](#2-principles)**

**[3. The seven checks](#3-the-seven-checks)** — [what they don't claim](#what-the-checks-deliberately-do-not-claim) · [one choice issue #27 decided](#one-choice-issue-27-decided)

**[4. Architecture](#4-architecture)** — [why a separate diagnosis layer](#why-a-separate-diagnosis-layer) · [enforced boundaries](#the-layering-is-enforced-rather-than-requested) · [scheduling](#scheduling)

**[5. The error layer](#5-the-error-layer)**

**[6. Security](#6-security)**

**[7. CLI](#7-cli)**

**[8. Deliberately out of scope](#8-deliberately-out-of-scope)**

---

# 1. The problem

The Solari cookbook README documents five gotchas *"that cost you an afternoon
if you meet them cold"*, and the repository's open issues are largely the same
class of problem being rediscovered independently:

| Issue | Rediscovered problem |
|:--|:--|
| [#1](https://github.com/solari-sdk/solari-cookbook/issues/1) | A key that was never fully copied |
| [#25](https://github.com/solari-sdk/solari-cookbook/issues/25) | Sessions that die while the status endpoint still reports them alive |
| [#27](https://github.com/solari-sdk/solari-cookbook/issues/27) | An SDK that needs an explicit base URL |

None of it is exotic. It is a **fixed, enumerable set** of known failure modes
that a new developer currently discovers by hitting them one at a time in real
code. There is no single command that says, before you write anything, which of
the known problems apply to your environment right now.

> **In one sentence:** recurring, already-documented Solari failure modes are
> diagnosed manually and repeatedly, with no automated first pass.

---

# 2. Principles

| | Principle | Why |
|:--|:--|:--|
| **1** | **Deterministic over clever** | No LLM anywhere in the diagnostic path. A tool that gives two answers for one broken environment erodes trust in every check, not just the flaky one |
| **2** | **Cheap by default, expensive by consent** | Anything costing more than a few seconds is opt-in behind `--full`. A diagnostic nobody runs has no value |
| **3** | **Facts, then diagnosis** | Checks report observations. A separate layer combines them into named causes |
| **4** | **Never touch what you didn't create** | No mutation of infrastructure, credentials, or project files |
| **5** | **Every claim has a source** | And no check claims more than it can observe |

---

# 3. The seven checks

| Check | Cost | Default | What it observes |
|:--|:--|:--|:--|
| `auth` | free | ✓ | Whether the key is absent, malformed, or rejected |
| `sdk-version` | free | ✓ | The installed `@solarisdk/browser` version against 0.1.3 |
| `browser-lifecycle` | cheap | ✓ | Whether a process that opened a session exits on its own |
| `sandbox-command` | cheap | ✓ | That commands are not shell-interpreted |
| `sandbox-cleanup` | cheap | ✓ | That `close()` leaves a VM running and `kill()` ends it |
| `session-liveness` | cheap | ✓ | That liveness is readable from the connection, not the status field |
| `recording-lifecycle` | expensive | `--full` | That a replay appears after a recorded session is released |

**Seven is a cap, not a target.** Each check is isolated, testable, cited, and
actionable; an eighth *"because we had time"* is how a bounded diagnostic
becomes an unbounded one.

## What the checks deliberately do not claim

| Check | The line it does not cross |
|:--|:--|
| `auth` | Detects *the resulting authentication failure*. It cannot observe the key-creation modal in issue #1 — that happened in a browser before the tool ran |
| `sdk-version` | Reports *exposure* to a documented bug from a static version read. Observing an actual hang is `browser-lifecycle`'s job |
| `sandbox-cleanup` | Proves the VM is still running after `close()`. The API exposes no billing field, so the wording stops at *"this may result in continued resource consumption/billing"* — never *"this is costing you money"* |
| `session-liveness` | Is structural. It does not reproduce issue #25's ten-minute timeline; that would cost ten minutes on every run. The finding is available on demand via `--explain session-liveness` |
| `recording-lifecycle` | Reports a timeout as **inconclusive**, not as a breach. Three live runs disagreed with each other and with both documented figures, so its poll ceiling is stated as this project's own margin rather than as a Solari guarantee. See *Replay timing* in [`FINDINGS.md`](FINDINGS.md#51-replay-timing) |

## One choice issue #27 decided

The sandbox checks use `SolariClient` from `@solarisdk/sdk`, which **defaults**
`baseUrl`, rather than the standalone `@solarisdk/sandbox`, which **requires**
it.

The standalone package would have forced this tool to hardcode a gateway
address — the same papercut #27 reports, in a tool whose job is diagnosing
environment problems.

---

# 4. Architecture

```
CLI
  → Check registry          the only place that enumerates checks
    → Scheduler             dependency graph, cost tiers, bounded concurrency
      → CheckResult[]
        → Diagnosis engine  pure: CheckResult[] -> Diagnosis[]
          → Renderers       terminal / JSON, both returning strings
            → --report      sanitised bundle
```

## Why a separate diagnosis layer

A check only knows about itself. *"The installed SDK is 0.1.2"* and *"the
process did not exit"* are two independent observations in isolation, and **one
high-confidence cause together**.

Correlating after the fact is the only way to get that without duplicating
version-awareness into every check that might care.

## The layering is enforced rather than requested

| Boundary | How it is enforced |
|:--|:--|
| The diagnosis layer is pure | A lint rule — importing the SDK, `node:*`, or any layer that performs I/O **fails the build** |
| Checks cannot print | `no-console` is an error outside the renderers and CLI |
| Only the registry enumerates checks | Nothing downstream switches on check ids |
| SDK errors are mapped in one module | So identical failures read identically |

## Scheduling

`free` checks run **first, unbounded**. Resource-creating checks run through a
worker pool **bounded at 3**, so the tool never opens six concurrent sessions
merely because the language allows it.

A failed dependency marks dependents `skip` — **never silently omitted**, and
always naming the check that blocked them.

---

# 5. The error layer

The two SDKs expose errors differently, and this is easy to get wrong:

| Package | Model |
|:--|:--|
| `@solarisdk/browser` | One class, `SolariError`, matched on `.status` / `.code` |
| `@solarisdk/core` (via `sdk`, `sandbox`) | A typed hierarchy: `AuthError` ← `GatewayError` ← `SolariError` |

Both packages export a class *named* `SolariError`, and **they are not the same
class** — a cross-package `instanceof` returns `false` silently. The mapper
takes the product explicitly, imports the two under distinct aliases, and flags
a mismatch in evidence rather than letting it present as an unhelpful diagnosis.

> **Ordering is load-bearing.** The four gateway subclasses must be tested
> before `GatewayError`, or every 401 becomes a generic gateway error with no
> compile or type error. A test locks the ordering, and it was verified by
> deliberately reversing the real implementation to confirm the test fails.

---

# 6. Security

The API key **never** appears in output, logs, or a `--report` bundle. Only
*present / correct format / auth succeeded* booleans are recorded.

The report sanitiser is a **whitelist**:

| Input | Treatment |
|:--|:--|
| Strings | Redacted and truncated |
| Numbers, booleans | Pass through |
| Arrays, plain objects | Recurse to a depth limit |
| Anything else — a class instance, a function, a buffer | Replaced by its type name |
| Keys named like credentials — `apiKey`, `cookie`, `storageState`, `screenshot` | Dropped regardless of value |

A check added later **cannot leak a shape the sanitiser has never seen**.

---

# 7. CLI

```
solari-doctor [--json] [--full] [--explain <id>] [--report]
```

One command, four flags. No subcommands, and no `--fix`: automatically running
`npm install` or rewriting a user's config is the riskiest possible thing to
demo, and a partially-tested auto-fix is worse than none.

| Exit | Meaning |
|:--|:--|
| `0` | Every check passed, warned, or was skipped |
| `1` | At least one check failed |
| `2` | Usage error — the diagnostic did not run |

> `warn` exits `0` **deliberately**: *"you are exposed to a documented issue"*
> is not *"your environment is broken"*, and CI should not go red for it.

`--report` writes `./solari-doctor-report.json` and prints the path to
**stderr**, so `solari-doctor --json --report > out.json` produces a valid file.

---

# 8. Deliberately out of scope

- No LLM in the diagnostic path
- No `--fix`
- No subcommand sprawl
- No telemetry pipeline
- No dashboard
- No cross-SDK conformance suite
- No eighth check

And no collapsing the four layers into one function under time pressure — **if
something has to give, a check goes before a layer does.**
