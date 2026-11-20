// Runs cpu-benchmark.browser.ts with each variant alone in a fresh headless browser, so one variant's
// JIT state cannot slow the other (see runCpuBenchmark). Needs `npm run dev:frontend` running and
// Playwright installed outside the repository (README, "CPU benchmark"):
//
//   node frontend/test/cpu-benchmark-run.mjs --playwright <dir> [--browser firefox|chromium]
//     [--compare centres|flow|both] [--sessions 5] [--url http://localhost:5173/] [--out results.json]
//
// Each session runs every variant of the chosen comparisons three times in its own browser; the
// variant order rotates between sessions. It prints each browser's runs and a summary and, with
// --out, writes the full results as JSON.

import { createRequire } from "node:module";
import { cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    playwright: { type: "string" },
    browser: { type: "string", default: "firefox" },
    compare: { type: "string", default: "both" },
    sessions: { type: "string", default: "5" },
    url: { type: "string", default: "http://localhost:5173/" },
    out: { type: "string" },
  },
});
if (!args.playwright) throw new Error("--playwright <dir>: the directory Playwright is installed in");
const require = createRequire(resolve(args.playwright, "package.json"));
const playwright = require("playwright");
const browserType = playwright[args.browser];
if (!["firefox", "chromium"].includes(args.browser) || !browserType) throw new Error("--browser firefox|chromium");
const comparisons = {
  centres: ["analytic", "called", "inline"],
  flow: ["sampled", "inlined"],
};
const chosen = args.compare === "both" ? ["centres", "flow"] : [args.compare];
if (!chosen.every((compare) => compare in comparisons)) throw new Error("--compare centres|flow|both");
const sessions = Number(args.sessions);
if (!Number.isInteger(sessions) || sessions < 1) throw new Error("--sessions must be a positive integer");
const page = new URL("test/benchmark.html", args.url).href;

const results = [];
let browserVersion;
for (let session = 0; session < sessions; session++) {
  for (const compare of chosen) {
    const variants = comparisons[compare];
    for (const variant of variants.map((_, k) => variants[(k + session) % variants.length])) {
      const browser = await browserType.launch({ headless: true });
      try {
        browserVersion = browser.version();
        const tab = await browser.newPage();
        await tab.goto(page);
        const result = await tab.evaluate(async ([compare, variant]) => {
          const { runCpuBenchmark } = await import("/test/cpu-benchmark.browser.ts");
          return runCpuBenchmark(compare, [variant, variant, variant]);
        }, [compare, variant]);
        results.push({ session, ...result });
        const means = result.runs.map((run) => run.meanMs.toFixed(3)).join(" / ");
        console.log(`session ${session} ${compare} ${variant}: ${means} ms, live ${result.runs[0].live}`);
      } finally {
        await browser.close();
      }
    }
  }
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
// The first variant of each comparison is the reference; every other one is compared with it.
const summary = chosen.map((compare) => {
  const [reference, ...rest] = comparisons[compare].map((variant) => {
    const means = results.filter((result) => result.compare === compare)
      .flatMap((result) => result.runs).filter((run) => run.variant === variant).map((run) => run.meanMs);
    return { variant, meanMs: mean(means), minMs: Math.min(...means), maxMs: Math.max(...means), runs: means.length };
  });
  return { compare, reference, candidates: rest.map((c) => ({ ...c, change: c.meanMs / reference.meanMs - 1 })) };
});
console.log(`\n${args.browser} ${browserVersion}, ${cpus()[0]?.model}, ${platform()} ${release()}`);
const range = (v) => `${v.meanMs.toFixed(3)} (${v.minMs.toFixed(3)}–${v.maxMs.toFixed(3)})`;
for (const { compare, reference: a, candidates } of summary) {
  for (const b of candidates) {
    console.log(`${compare}: ${a.variant} ${range(a)} → ${b.variant} ${range(b)} ms, ` +
      `${(b.change * 100).toFixed(1)} %, ${a.runs} runs each`);
  }
}
if (args.out) {
  const host = { cpu: cpus()[0]?.model, platform: platform(), release: release() };
  const playwrightVersion = require("playwright/package.json").version;
  writeFileSync(args.out, JSON.stringify({
    date: new Date().toISOString(), browser: args.browser, browserVersion, playwrightVersion, host, summary, results,
  }, null, 2) + "\n");
}
