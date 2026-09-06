/**
 * Terminal renderer — design.md §4.
 *
 * Returns a string; it does not print. The CLI owns every write to stdout
 * (module 8), which keeps this layer snapshot-testable and keeps I/O in one
 * place. Renderers consume `CheckResult[]` and `Diagnosis[]` and nothing
 * imports back out of them.
 */

import type { CheckResult, CheckStatus, Diagnosis } from "../types.js";

export interface TerminalOptions {
  /** ANSI colour. Callers pass `false` for a non-TTY, a pipe, or NO_COLOR. */
  color?: boolean;
  /** Wrap width for remediation text. */
  width?: number;
}

const DEFAULT_WIDTH = 80;

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
} as const;

/**
 * Status glyphs are ASCII, not Unicode symbols.
 *
 * A diagnostic that renders as mojibake in the terminal it is diagnosing has
 * undermined its own credibility before the reader gets to the content, and
 * Windows consoles are exactly where that happens.
 */
const GLYPH: Readonly<Record<CheckStatus, string>> = {
  pass: "+",
  warn: "!",
  fail: "x",
  skip: "-",
};

const COLOR: Readonly<Record<CheckStatus, string>> = {
  pass: ANSI.green,
  warn: ANSI.yellow,
  fail: ANSI.red,
  skip: ANSI.dim,
};

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

/** Greedy wrap. Words longer than the width are left intact rather than cut. */
export function wrapText(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (indent.length + current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(indent + current);
      current = word;
    }
  }
  lines.push(indent + current);
  return lines;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function summarise(results: readonly CheckResult[]): string {
  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of results) counts[result.status] += 1;

  const parts = [`${results.length} ${results.length === 1 ? "check" : "checks"}`];
  if (counts.pass > 0) parts.push(`${counts.pass} passed`);
  if (counts.warn > 0) parts.push(`${counts.warn} warned`);
  if (counts.fail > 0) parts.push(`${counts.fail} failed`);
  if (counts.skip > 0) parts.push(`${counts.skip} skipped`);
  return parts.join(" · ");
}

export function renderTerminal(
  results: readonly CheckResult[],
  diagnoses: readonly Diagnosis[],
  options: TerminalOptions = {},
): string {
  const color = options.color ?? false;
  const width = options.width ?? DEFAULT_WIDTH;
  const lines: string[] = [];

  lines.push(paint("solari-doctor", ANSI.bold, color));
  lines.push("");

  if (results.length === 0) {
    lines.push("  no checks ran");
    lines.push("");
    return lines.join("\n");
  }

  const idWidth = Math.max(...results.map((r) => r.id.length));

  for (const result of results) {
    const glyph = paint(GLYPH[result.status], COLOR[result.status], color);
    const id = result.id.padEnd(idWidth);
    const duration = paint(formatDuration(result.durationMs), ANSI.dim, color);
    lines.push(`  ${glyph} ${id}  ${result.message}  ${duration}`);

    // Remediation belongs to a check only when that check itself failed; a
    // passing check with advice attached is noise.
    if (result.remediation !== undefined && result.status !== "pass") {
      lines.push(...wrapText(result.remediation, width, "      "));
    }
  }

  if (diagnoses.length > 0) {
    lines.push("");
    lines.push(paint("diagnosis", ANSI.bold, color));
    lines.push("");

    for (const diagnosis of diagnoses) {
      lines.push(...wrapText(diagnosis.cause, width, "  "));

      const from = diagnosis.supportingChecks.join(", ");
      const meta = [`confidence: ${diagnosis.confidence}`];
      if (from.length > 0) meta.push(`from: ${from}`);
      if (diagnosis.issueRef !== undefined) meta.push(diagnosis.issueRef);
      lines.push(paint(`    ${meta.join(" · ")}`, ANSI.dim, color));

      lines.push(...wrapText(diagnosis.remediation, width, "    "));
      lines.push("");
    }
    lines.pop();
  }

  lines.push("");
  lines.push(paint(summarise(results), ANSI.cyan, color));
  lines.push("");

  return lines.join("\n");
}
