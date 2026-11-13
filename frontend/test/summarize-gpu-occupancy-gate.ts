/// <reference types="node" />
/**
 * Applies the approved occupancy gate to the JSON exported by runGpuOccupancyGate(). From the
 * repository root: `npx tsx frontend/test/summarize-gpu-occupancy-gate.ts <export.json> [--output <file>]`.
 * Exits 0 only if calibration and the GPU comparison both pass. The output keeps the browser's
 * metadata, runs and calibration unchanged and adds the comparisons and summary.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { evaluateGate } from "./fixtures/occupancy-gate";

const args = process.argv.slice(2);
const [input] = args;
const output = args[1] === "--output" ? args[2] : undefined;
if (!input || input.startsWith("--") || !(args.length === 1 || (args.length === 3 && output))) {
  console.error("Usage: summarize-gpu-occupancy-gate.ts <export.json> [--output <file>]");
  process.exit(2);
}
const raw = JSON.parse(readFileSync(input, "utf8"));
if (raw.metadata?.runsPerGroup !== 20) throw new Error("Not a full gate run (runsPerGroup must be 20)");
const { comparisons, summary } = evaluateGate(raw.runs);
if (output) writeFileSync(output, JSON.stringify({ ...raw, comparisons, summary }, null, 1) + "\n");
console.log(JSON.stringify(summary, null, 1));
process.exit(summary.gatePassed ? 0 : 1);
