# solari-doctor

A deterministic diagnostic for documented Solari failure modes. One command,
seven checks, no LLM in the diagnostic path.

The cookbook README lists five gotchas "that cost you an afternoon if you meet
them cold", and the open issues are largely the same problems being
rediscovered independently. I identified a repeated developer pain point and
built a lightweight tool that could eliminate a class of repetitive debugging
work — telling you which of the known problems apply to your environment before
you write real code.

## Usage

```bash
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npx solari-doctor
```

```
solari-doctor [--json] [--full] [--explain <id>] [--report]

  --json          machine-readable output on stdout
  --full          also run expensive checks
  --explain <id>  print the documented finding for one check
  --report        write a sanitised report to ./solari-doctor-report.json
```

Exit `0` when everything passed, warned or was skipped; `1` when a check
failed; `2` on a usage error. A warning exits `0` on purpose — "you are exposed
to a documented issue" is not "your environment is broken".

## What it looks like

Run against a project pinned to `@solarisdk/browser` 0.1.2. This is real
captured output, not an illustration:

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

The last block is the point of the tool. `sdk-version` read a version and
`browser-lifecycle` watched a child process — two observations that are
inconclusive alone. Neither check knows about the other; a separate layer
correlated them into one named cause.

## The checks

| Check | Cost | Default | What it observes |
|---|---|---|---|
| `auth` | free | yes | Whether the key is absent, malformed, or rejected |
| `sdk-version` | free | yes | The installed `@solarisdk/browser` version against 0.1.3 |
| `browser-lifecycle` | cheap | yes | Whether a process that opened a session exits on its own |
| `sandbox-command` | cheap | yes | That commands are not shell-interpreted |
| `sandbox-cleanup` | cheap | yes | That `close()` leaves a VM running and `kill()` ends it |
| `session-liveness` | cheap | yes | That liveness is readable from the connection, not the status field |
| `recording-lifecycle` | expensive | `--full` | That a replay appears after a recorded session is released |

Checks that create real resources run through a worker pool bounded at 3, and
every one of them kills what it created on every path — including when its own
assertions fail.

## Documentation

- [docs-public/DESIGN.md](docs-public/DESIGN.md) — architecture, the seven
  checks, what each deliberately does not claim
- [docs-public/FINDINGS.md](docs-public/FINDINGS.md) — what was verified about
  the SDKs, and how

## Development

```bash
npm run check    # typecheck (src + tests), lint, tests
npm run build
npm test
```

329 tests, none of which reach a live Solari service. The live integration run
is a separate, manually triggered workflow.

## Notes

`recording-lifecycle` can report a timeout as inconclusive rather than as a
failure: three live runs of the replay cycle disagreed with each other and with
Solari's own documented figures. The check states both numbers and declines to
claim a guarantee was breached — see
[FINDINGS.md](docs-public/FINDINGS.md#open-and-not-blocking).

A separate documentation fix for the cookbook's TypeScript examples, which still
described the pre-0.1.3 close behaviour, is proposed upstream on the
`fix-browser-close-example` branch. It is a distinct contribution rather than
part of this project.
