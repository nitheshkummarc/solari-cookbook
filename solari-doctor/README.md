# solari-doctor

Checks your environment against known Solari failure modes before you hit them.

```
$ npx solari-doctor

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

Real output from a project pinned to 0.1.2, not a constructed example. The
`diagnosis` block is the part worth noticing: two checks that are inconclusive
on their own — a version number and a child process that didn't exit — get
correlated into one named cause.

## The problem

Every SDK has a handful of documented failure modes that cost an afternoon
each: a key that was never fully copied, a process that hangs on exit, a VM that
keeps running after you thought you stopped it. They're all written down
somewhere, in a README gotcha or a GitHub issue.

Nothing checks them for you, so each one gets rediscovered by hitting it in real
code.

## What it checks

| Check | What it catches | Source |
|---|---|---|
| `auth` | A key that is missing, malformed, or rejected | [issue #1](https://github.com/solari-sdk/solari-cookbook/issues/1) |
| `sdk-version` | `@solarisdk/browser` older than 0.1.3, where `browser.close()` alone can hang the process | [gotcha 1](../README.md#gotchas-the-examples-encode) |
| `browser-lifecycle` | A process that opened a session and doesn't exit — observed, not inferred | [gotcha 1](../README.md#gotchas-the-examples-encode) |
| `sandbox-command` | `run("ls -la")` looking for a binary named `ls -la`, because commands aren't shell-interpreted | [gotcha 3](../README.md#gotchas-the-examples-encode) |
| `sandbox-cleanup` | A VM still running after `close()` — only `kill()` stops it | [gotcha 4](../README.md#gotchas-the-examples-encode) |
| `session-liveness` | Code trusting `status` for liveness, when the status endpoint reports dead sessions as active | [issue #25](https://github.com/solari-sdk/solari-cookbook/issues/25) |
| `recording-lifecycle` | A replay that 404s forever because `recording: true` wasn't set at creation | [gotcha 2](../README.md#gotchas-the-examples-encode) |

## Usage

```bash
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npx solari-doctor
```

| Flag | |
|---|---|
| `--json` | machine-readable output on stdout |
| `--full` | also run expensive checks (adds a real ~30s wait) |
| `--explain <id>` | print the documented finding for one check |
| `--report` | write a sanitised report to `./solari-doctor-report.json` |

Exit `0` when everything passed, warned, or was skipped; `1` when a check
failed; `2` on a usage error. A warning exits `0` — "you're exposed to a
documented issue" isn't "your environment is broken".

## Why you can trust the results

Every check was verified against the real SDK, not inferred from documentation.
Where the docs and reality disagreed, reality won and the docs got a bug report.

The `sdk-version` + `browser-lifecycle` pair above is the clearest example. The
documented claim was that the hang is fixed in 0.1.3. That was confirmed by
running the same script against two real installs — 0.1.2 hung past 75 seconds,
0.1.3 exited in about 3 — and the same run showed the cookbook's own TypeScript
examples still carried the pre-0.1.3 advice. That's now
[a separate PR](https://github.com/solari-sdk/solari-cookbook) against the
cookbook.

The tests are not the last line of defence. **Four real defects survived a green
test suite and were caught only by running the tool against a live environment:**
the CLI never read `SOLARI_API_KEY`; one check closed an SDK client three others
were sharing; a unit test was quietly making live API calls; and two checks
disagreed about whether a missing SDK was a warning or a failure. Unit tests
verify units — the defects live in the wiring between them.

Full evidence, including what remains unresolved, is in
[docs-public/FINDINGS.md](docs-public/FINDINGS.md).

## How it works

```
CLI → registry → scheduler → CheckResult[] → diagnosis → renderer
```

Checks report observations and never print. A separate pure layer correlates
those observations into named causes — which is the only way to say "these two
facts together mean X" without teaching every check about every other check.
Checks that create real resources run through a worker pool bounded at three,
and each one destroys what it created on every path, including when its own
assertions fail.

Full rationale and trade-offs in [docs-public/DESIGN.md](docs-public/DESIGN.md).

## What this is not

- **No LLM in the diagnostic path.** The same broken environment gives the same
  answer every time. That's the whole value.
- **No `--fix`.** It diagnoses and reports; it never mutates your project,
  credentials, or infrastructure.
- **Seven checks, deliberately.** Bounded to documented failure modes. An eighth
  "because we had time" is how a focused tool stops being one.
- **No cross-SDK claims.** The protocol document the SDK READMEs reference isn't
  public, so this makes no claim about wire compatibility between languages.

## Development

```bash
npm ci
npm run check    # typecheck (src + tests), lint, tests
npm run build
```

332 tests, none of which reach a live Solari service. The live run is a separate,
manually triggered workflow.
