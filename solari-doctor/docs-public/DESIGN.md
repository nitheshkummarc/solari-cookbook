# solari-doctor — design

A deterministic CLI that checks a developer's environment against a fixed set of
documented Solari failure modes, and reports for each one what is wrong, why,
and what to do about it.

## The problem

The Solari cookbook README documents five gotchas "that cost you an afternoon if
you meet them cold", and the repository's open issues are largely the same class
of problem being rediscovered independently — a key that was never fully copied
(#1), sessions that die while the status endpoint still reports them alive
(#25), an SDK that needs an explicit base URL (#27).

None of it is exotic. It is a fixed, enumerable set of known failure modes that
a new developer currently discovers by hitting them one at a time in real code.
There is no single command that says, before you write anything, which of the
known problems apply to your environment right now.

**In one sentence:** recurring, already-documented Solari failure modes are
diagnosed manually and repeatedly, with no automated first pass.

## Principles

1. **Deterministic over clever.** No LLM anywhere in the diagnostic path. A tool
   that gives two answers for one broken environment erodes trust in every check,
   not just the flaky one.
2. **Cheap by default, expensive by consent.** Anything costing more than a few
   seconds is opt-in behind `--full`. A diagnostic nobody runs has no value.
3. **Facts, then diagnosis.** Checks report observations. A separate layer
   combines them into named causes.
4. **Never touch what you didn't create.** No mutation of infrastructure,
   credentials, or project files.
5. **Every claim has a source**, and no check claims more than it can observe.

## The seven checks

| Check | Cost | Default | What it observes |
|---|---|---|---|
| `auth` | free | yes | Whether the key is absent, malformed, or rejected |
| `sdk-version` | free | yes | The installed `@solarisdk/browser` version against 0.1.3 |
| `browser-lifecycle` | cheap | yes | Whether a process that opened a session exits on its own |
| `sandbox-command` | cheap | yes | That commands are not shell-interpreted |
| `sandbox-cleanup` | cheap | yes | That `close()` leaves a VM running and `kill()` ends it |
| `session-liveness` | cheap | yes | That liveness is readable from the connection, not the status field |
| `recording-lifecycle` | expensive | `--full` | That a replay appears after a recorded session is released |

Seven is a cap, not a target. Each check is isolated, testable, cited, and
actionable; an eighth "because we had time" is how a bounded diagnostic becomes
an unbounded one.

### What the checks deliberately do not claim

- **`auth`** detects *the resulting authentication failure*. It cannot observe
  the key-creation modal in issue #1 — that happened in a browser before the
  tool ran.
- **`sdk-version`** reports *exposure* to a documented bug from a static version
  read. Observing an actual hang is `browser-lifecycle`'s job.
- **`sandbox-cleanup`** proves the VM is still running after `close()`. The API
  exposes no billing field, so the wording stops at "this may result in
  continued resource consumption/billing" — never "this is costing you money".
- **`session-liveness`** is structural. It does not reproduce issue #25's
  ten-minute timeline; that would cost ten minutes on every run. The finding is
  available on demand via `--explain session-liveness`.

## Architecture

```
CLI
  → Check registry          the only place that enumerates checks
    → Scheduler             dependency graph, cost tiers, bounded concurrency
      → CheckResult[]
        → Diagnosis engine  pure: CheckResult[] -> Diagnosis[]
          → Renderers       terminal / JSON, both returning strings
            → --report      sanitised bundle
```

**Why a separate diagnosis layer.** A check only knows about itself. "The
installed SDK is 0.1.2" and "the process did not exit" are two independent
observations in isolation, and one high-confidence cause together. Correlating
after the fact is the only way to get that without duplicating version-awareness
into every check that might care.

The layering is enforced rather than requested:

- The diagnosis layer's purity is a lint rule — importing the SDK, `node:*`, or
  any layer that performs I/O fails the build.
- Checks cannot print: `no-console` is an error outside the renderers and CLI.
- Only the registry enumerates checks; nothing downstream switches on check ids.
- SDK errors are mapped in one module, so identical failures read identically.

**Scheduling.** `free` checks run first, unbounded. Resource-creating checks run
through a worker pool bounded at 3, so the tool never opens six concurrent
sessions merely because the language allows it. A failed dependency marks
dependents `skip` — never silently omitted, and always naming the check that
blocked them.

## The error layer

The two SDKs expose errors differently, and this is easy to get wrong:

| Package | Model |
|---|---|
| `@solarisdk/browser` | one class, `SolariError`, matched on `.status` / `.code` |
| `@solarisdk/core` (via `sdk`, `sandbox`) | a typed hierarchy: `AuthError` ← `GatewayError` ← `SolariError` |

Both packages export a class *named* `SolariError`, and they are not the same
class — a cross-package `instanceof` returns `false` silently. The mapper takes
the product explicitly, imports the two under distinct aliases, and flags a
mismatch in evidence rather than letting it present as an unhelpful diagnosis.

Ordering is load-bearing: the four gateway subclasses must be tested before
`GatewayError`, or every 401 becomes a generic gateway error with no compile or
type error. A test locks the ordering, and it was verified by deliberately
reversing the real implementation to confirm the test fails.

## Security

The API key never appears in output, logs, or a `--report` bundle. Only
"present / correct format / auth succeeded" booleans are recorded.

The report sanitiser is a **whitelist**: strings are redacted and truncated,
numbers and booleans pass, arrays and plain objects recurse to a depth limit,
and anything else — a class instance, a function, a buffer — is replaced by its
type name. A check added later cannot leak a shape the sanitiser has never seen.
Keys named like credentials (`apiKey`, `cookie`, `storageState`, `screenshot`)
are dropped regardless of value.

## CLI

```
solari-doctor [--json] [--full] [--explain <id>] [--report]
```

One command, four flags. No subcommands, and no `--fix`: automatically running
`npm install` or rewriting a user's config is the riskiest possible thing to
demo, and a partially-tested auto-fix is worse than none.

| Exit | Meaning |
|---|---|
| `0` | every check passed, warned, or was skipped |
| `1` | at least one check failed |
| `2` | usage error — the diagnostic did not run |

`warn` exits `0` deliberately: "you are exposed to a documented issue" is not
"your environment is broken", and CI should not go red for it.

`--report` writes `./solari-doctor-report.json` and prints the path to **stderr**,
so `solari-doctor --json --report > out.json` produces a valid file.

## Deliberately out of scope

No LLM in the diagnostic path. No `--fix`. No subcommand sprawl. No telemetry
pipeline. No dashboard. No cross-SDK conformance suite. No eighth check. And no
collapsing the four layers into one function under time pressure — if something
has to give, a check goes before a layer does.
