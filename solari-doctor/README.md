# solari-doctor

[![CI](https://github.com/nitheshkummarc/solari-cookbook/actions/workflows/solari-doctor-ci.yml/badge.svg?branch=solari-doctor)](https://github.com/nitheshkummarc/solari-cookbook/actions/workflows/solari-doctor-ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-5fa04e)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

A deterministic diagnostic CLI that detects documented Solari configuration,
SDK-version, lifecycle, and resource-cleanup failures before they cost
developers hours of debugging.

## Catching a real bug

Run against a project pinned to `@solarisdk/browser` 0.1.2. Verbatim output, not
a mockup:

```
solari-doctor

  + auth               the API key authenticated successfully  1.2s
  ! sdk-version        @solarisdk/browser 0.1.2 is older than 0.1.3  0ms
      Upgrade to @solarisdk/browser 0.1.3 or later, where the connection-retry
      listener is unref'd and browser.close() alone is enough to exit. Until
      then, call await solari.close() in a finally block.
  x browser-lifecycle  the process did not exit within 5000ms of closing the browser  7.7s
      A process that opens a session should exit once the browser is closed. On
      @solarisdk/browser below 0.1.3 the connection-retry listener holds the
      event loop open; upgrade, or call await solari.close() in a finally block.
  + sandbox-command    commands are not shell-interpreted, as documented  3.3s
  + sandbox-cleanup    close() left the sandbox running until kill() ended it  2.3s
  + session-liveness   isConnected() reported false once the session ended  2.1s

diagnosis

  the installed @solarisdk/browser is older than 0.1.3, and a process that
  opened a session did not exit — the documented loopback-proxy hang
    confidence: high · from: sdk-version, browser-lifecycle · solari-cookbook#README-gotcha-1
    Upgrade to @solarisdk/browser 0.1.3 or later, where the retry listener is
    unref'd and browser.close() alone is enough to exit. Until then, call await
    solari.close() in a finally block.

6 checks · 4 passed · 1 warned · 1 failed
```

Two checks that are inconclusive alone — a version number, and a child process
that didn't exit — correlated into one named cause with a confidence level. The
version read shows exposure; the lifecycle observation shows a symptom; neither
check knows the other exists.

## The problem

Every SDK has a handful of documented failure modes that cost an afternoon
each: a key that was never fully copied, a process that hangs on exit, a VM
still running after you thought you stopped it. They are all written down
somewhere — a README gotcha, a GitHub issue.

Nothing checks them for you, so each one gets rediscovered by hitting it in
real code.

## Engineering at a glance

| | |
|---|---|
| **7 checks** | Bounded to documented failure modes; capped by design |
| **332 tests** | 15 suites, none reaching a live service |
| **4 defects caught only by live runs** | After the unit suite was already green |
| **2 real SDK versions** | Verified against a real 0.1.2 hang and a real 0.1.3 pass, not fixtures alone |
| **0 LLM calls** | Nothing in the diagnostic path is non-deterministic |
| **Gates green at every commit** | typecheck, lint, test, build — 19 commits |

## What it checks

| Check | Catches | Source |
|---|---|---|
| `auth` | A key that is missing, malformed, or rejected | [#1](https://github.com/solari-sdk/solari-cookbook/issues/1) |
| `sdk-version` | `@solarisdk/browser` below 0.1.3, where `browser.close()` alone can hang the process | [gotcha 1](../README.md#gotchas-the-examples-encode) |
| `browser-lifecycle` | A process that opened a session and does not exit — observed out-of-process, not inferred | [gotcha 1](../README.md#gotchas-the-examples-encode) |
| `sandbox-command` | `run("ls -la")` looking for a binary named `ls -la`, because commands are not shell-interpreted | [gotcha 3](../README.md#gotchas-the-examples-encode) |
| `sandbox-cleanup` | A VM still running after `close()` — only `kill()` stops it | [gotcha 4](../README.md#gotchas-the-examples-encode) |
| `session-liveness` | Code trusting `status` for liveness, when the endpoint reports dead sessions as active | [#25](https://github.com/solari-sdk/solari-cookbook/issues/25) |
| `recording-lifecycle` | A replay that 404s forever because `recording: true` was not set at creation | [gotcha 2](../README.md#gotchas-the-examples-encode) |

## Key engineering decisions

**Facts and diagnosis are separate layers.** Checks report raw observations and
nothing else. A pure `CheckResult[] -> Diagnosis[]` function correlates them
into named causes with confidence levels. This is what turns two inconclusive
signals into the single high-confidence diagnosis shown above, without teaching
every check about every other check. The layer's purity is enforced by a lint
rule, not by convention — importing the SDK or any I/O from it fails the build.

**Two-model error mapping.** The browser SDK and the core/sandbox SDK expose
genuinely different error surfaces: one untyped `SolariError` matched on
`status`/`code`, and one real typed hierarchy. Both packages export a class
*named* `SolariError`, and they are not the same class — a cross-package
`instanceof` silently returns `false`. Every check routes through one shared
mapping layer whose `instanceof` ordering is locked by a test, rather than each
check guessing.

**Dependency-aware, bounded scheduling.** Free checks run first and unbounded;
resource-creating checks run through a worker pool capped at three, so the tool
never opens six concurrent sessions merely because the language allows it. A
failed dependency marks its dependents `skip` — never silently omitted, always
naming the check that blocked them.

**Verification-first, not documentation-first.** Every check's behaviour was
confirmed against the real installed SDK before being trusted. Where the docs
and reality disagreed, reality won.

## Verification approach

Unit tests were not sufficient, and this is stated as a finding rather than an
apology. Four real defects survived a green suite and were caught only by
running the built tool against the live SDK:

| Defect | How it presented |
|---|---|
| The CLI never read `SOLARI_API_KEY` | 194 tests green; the real run reported a present key as missing |
| `package.json` is not an exported subpath | `require` of the SDK manifest throws; the version check needed a filesystem read |
| A cleanup path cancelled its own kill-fallback timer | A child ignoring `SIGTERM` would have been leaked by the code meant to prevent that |
| A fixture resembled but was not the real SDK error class | It satisfied the check's own field read while the shared mapper classified it as unrecognised |

Two more emerged from running all seven checks together rather than in
isolation: one check closed an SDK client three others were sharing, and two
checks disagreed about whether a missing SDK was a warning or a failure.

The practice is deliberate: **every check gets a real run against the actual SDK
before it is considered complete.** The `browser-lifecycle` boundary, for
instance, was established by running the same script against two real installs —
0.1.2 hung past 75 seconds, 0.1.3 exited in about 3.

Full evidence in [docs-public/FINDINGS.md](docs-public/FINDINGS.md).

## Architecture

```
CLI
  └─ Registry          the only place that enumerates checks
      └─ Scheduler     dependency graph · cost tiers · concurrency cap of 3
          └─ CheckResult[]
              └─ Diagnosis engine    pure: CheckResult[] -> Diagnosis[]
                  └─ Renderers       terminal · JSON · sanitised report
```

Facts and diagnosis are separate because a check only knows about itself.
Correlating after the fact is the only way to say "these two observations
together mean X" without duplicating cross-check logic into every check that
might care — and it keeps the correlation layer exhaustively testable, because
it performs no I/O at all.

Full rationale and trade-offs in [docs-public/DESIGN.md](docs-public/DESIGN.md).

## What this is not

- **No LLM anywhere in the diagnostic path.** The same broken environment gives
  the same answer every time.
- **No `--fix` or auto-mutation.** It diagnoses and reports; it never changes
  your project, credentials, or infrastructure.
- **No subcommand sprawl.** One command, four flags.
- **No cross-SDK conformance testing.** Three SDK READMEs reference a
  `PROTOCOL.md` that is not publicly available, so no claim is made about wire
  compatibility between languages. That is a consequence of the evidence, not
  only a scoping choice.
- **Seven checks, capped by design** — not by running out of time.

## Tech stack

| | |
|---|---|
| Language | TypeScript 6.0, strict, `exactOptionalPropertyTypes` |
| Runtime | Node ≥ 20, ESM (the SDK is ESM-only) |
| SDKs | `@solarisdk/browser`, `@solarisdk/sandbox`, `@solarisdk/sdk` — all 0.1.3 |
| Tests | vitest 5 |
| Lint | ESLint 10 flat config + typescript-eslint, with layer rules enforced |
| CI | GitHub Actions — ubuntu + windows × node 20/24 |

## Install and usage

```bash
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npx solari-doctor
```

| Flag | |
|---|---|
| `--json` | machine-readable output on stdout |
| `--full` | also run expensive checks (adds a real wait) |
| `--explain <id>` | print the documented finding for one check |
| `--report` | write a sanitised report to `./solari-doctor-report.json` |

Exit `0` when everything passed, warned, or was skipped; `1` when a check
failed; `2` on a usage error. A warning exits `0` — "you are exposed to a
documented issue" is not "your environment is broken".

## Testing

| Suite | Result |
|---|---|
| Unit (mocked SDK) | 332 passing, 15 suites |
| Live verification (L3/L4) | 7/7 checks confirmed against the real SDK |
| CI (PR gate) | typecheck · lint · test · build, on ubuntu + windows |
| Live integration | separate, secret-gated, manual + weekly |

Two suites are mutation-verified: the concurrency bound and the `instanceof`
ordering were each broken deliberately to confirm the tests fail.

## Repository layout

```
solari-doctor/
├── src/
│   ├── checks/            one file per check + the registry
│   │   ├── auth.ts  sdk-version.ts  browser-lifecycle.ts
│   │   ├── sandbox-command.ts  sandbox-cleanup.ts
│   │   ├── session-liveness.ts  recording-lifecycle.ts
│   │   ├── browser-lifecycle-harness.ts   child process
│   │   └── sdk-install.ts index.ts
│   ├── runner/            scheduler.ts · errors.ts
│   ├── diagnosis/         engine.ts (pure) · rules.ts (data)
│   ├── report/            terminal.ts · json.ts · bundle.ts
│   ├── cli.ts  bin.ts  context.ts  types.ts  explain.ts  version.ts
├── test/                  mirrors src/, plus fixtures/
├── ci/cleanup.mjs         sweeps resources a cancelled CI run left behind
└── docs-public/           DESIGN.md · FINDINGS.md
```

## Notes worth flagging

**The recording poll window is empirically variable.** Three live runs
disagreed — no replay in 60s, a replay at 8.2s, no replay in 46s — against a
documented ~30s and an SDK doc comment saying ~1-3s. `recording-lifecycle`
reports a timeout as *inconclusive*, states Solari's figure and its own ceiling
as separate numbers, and does not claim a guarantee was breached. This is stated
honestly rather than presented as settled.

**`PROTOCOL.md` is referenced but not published.** Three SDK READMEs point at a
protocol contract that is absent from every public repository. Cross-SDK
conformance is out of scope for that reason, and three questions are open for
the maintainers.

**A related, separate contribution.** The cookbook's TypeScript examples still
described the pre-0.1.3 close behaviour. That fix is proposed upstream on the
`fix-browser-close-example` branch — a distinct contribution, not part of this
project.

## License

[MIT](LICENSE), matching the cookbook this lives in.
