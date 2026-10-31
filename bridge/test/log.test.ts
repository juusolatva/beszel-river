import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.js";

describe("log", () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => stdout.push(String(chunk)) > 0);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => stderr.push(String(chunk)) > 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("writes info to stdout and warnings and errors to stderr, with a timestamp and level", () => {
    log("info", "hello");
    log("warn", "careful");
    log("error", "broken");
    expect(stdout).toEqual(["2026-10-26T12:00:00.000Z INFO hello\n"]);
    expect(stderr).toEqual(["2026-10-26T12:00:00.000Z WARN careful\n", "2026-10-26T12:00:00.000Z ERROR broken\n"]);
  });

  it("appends an error with its cause chain", () => {
    const error = new Error("Something went wrong.", { cause: new Error("fetch failed", { cause: new Error("connect ECONNREFUSED") }) });
    log("error", "Login failed", error);
    expect(stderr[0]).toBe("2026-10-26T12:00:00.000Z ERROR Login failed: Something went wrong. ← fetch failed ← connect ECONNREFUSED\n");
  });

  it.each(["info", "warn", "error"] as const)("escapes line breaks in %s messages and upstream errors", (level) => {
    log(level, "Login\r\nforged", new Error("upstream\nforged", { cause: "cause\rforged" }));
    const output = level === "info" ? stdout : stderr;
    expect(output[0]).toBe(`2026-10-26T12:00:00.000Z ${level.toUpperCase()} Login\\r\\nforged: upstream\\nforged ← cause\\rforged\n`);
  });

  it("bounds deep and cyclic error causes", () => {
    const cyclic = new Error("cycle");
    cyclic.cause = cyclic;
    log("error", "cyclic", cyclic);
    let deep = new Error("hidden");
    for (let i = 0; i < 10; i++) deep = new Error("outer", { cause: deep });
    log("error", "deep", deep);
    for (const line of stderr) {
      expect(line).toContain("[cause chain truncated]");
      expect(line.split(" ← ")).toHaveLength(6);
      expect(line).not.toContain("hidden");
    }
  });

  it("redacts credentials in HTTP causes and suppresses malformed URLs", () => {
    log("error", "request", { status: 403, url: "https://user:secret@hub/api/x" }); // betterleaks:allow -- synthetic URL credentials
    log("error", "request", { status: 403, url: "https://user:secret@[" }); // betterleaks:allow -- synthetic URL credentials
    expect(stderr[0]).toContain("HTTP 403 https://hub/api/x");
    expect(stderr[1]).toContain("HTTP 403 [invalid URL]");
    expect(stderr.join("")).not.toMatch(/user|secret/);
  });

  it("describes the SDK's HTTP causes and values that are not errors", () => {
    log("error", "a", new Error("Forbidden.", { cause: { url: "http://hub/api/x", status: 403, data: {} } }));
    log("error", "b", "plain text");
    log("error", "c", null);
    log("error", "d", { status: "403", url: "x" });
    expect(stderr.map((line) => line.slice(25))).toEqual([
      "ERROR a: Forbidden. ← HTTP 403 http://hub/api/x\n",
      "ERROR b: plain text\n",
      "ERROR c: null\n",
      "ERROR d: [object Object]\n",
    ]);
  });
});
