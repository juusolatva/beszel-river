import { runGpuBenchmark } from "./gpu-benchmark.browser";
import type { RecordedSchedule } from "./fixtures/gpu-replay";
import { buildRunPlan, DEFAULT_WORKLOADS, estimateMinutes, ledgerMarkdown, summarizeRun, WORKLOADS, type FailedRun, type RunEnvironment, type RunSpec,
  type RunSummary, type SequenceConfig, type Viewport } from "./fixtures/run-sequence";

/**
 * Drives the paired CPU/GPU comparison one run per page load: `runGpuBenchmark` needs fresh GL
 * resources for every run, so the page reloads in between and keeps its plan and summaries in local
 * storage. Local experiment page only; the public page never loads it.
 */

const STORAGE_KEY = "beszel-river-gpu-sequence";
const COUNTDOWN_SECONDS = 3;

interface SequenceState {
  version: 1;
  config: SequenceConfig;
  conditions: string;
  refreshHz: number;
  commit: string;
  plan: RunSpec[];
  next: number;
  results: (RunSummary | FailedRun)[];
  schedules: Partial<Record<Viewport, RecordedSchedule>>;
  status: "running" | "paused" | "done";
  /** The viewport the person has confirmed the window for, so the sequence does not stop again. */
  readyViewport: Viewport | null;
  /** The window size when it was confirmed; a full-screen confirmation lapses when it changes. */
  readySize?: [number, number] | null;
  message: string;
}

/**
 * Run IDs (`crypto.randomUUID`), the battery state and the screen wake lock exist only in secure
 * contexts, which a page loaded from a LAN address is not. A phone reaches localhost through adb.
 */
const INSECURE = "This page is not a secure context, so every run would fail (crypto.randomUUID) and neither the battery state nor the screen wake lock is available. "
  + "Open it through localhost (on a phone: adb reverse tcp:5173 tcp:5173, then http://localhost:5173/test/gpu-sequence.html) or HTTPS.";

let screenLock: WakeLockSentinel | null = null;
/** Lock requests left on this page load, which holds one run. */
let screenLockRequests = 5;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

function load(): SequenceState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const state = raw ? (JSON.parse(raw) as SequenceState) : null;
    return state?.version === 1 ? state : null;
  } catch {
    return null;
  }
}

/**
 * Stores the state, or pauses it when storage refuses (full or blocked): reloading after a failed
 * save would rerun the same run forever. The results stay on the page to download.
 */
function save(state: SequenceState): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    state.status = "paused";
    state.message = `Could not store the sequence (${String(error)}). Download the results below before reloading.`;
    return false;
  }
}

function status(text: string, warn = false): void {
  const element = $("#status");
  element.textContent = text;
  element.className = warn ? "warn" : "";
}

function button(label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener("click", action);
  $("#actions").append(element);
  return element;
}

/**
 * Keeps the screen on while the sequence runs: a phone on battery has no setting for that, and a
 * locked screen hides the tab, which invalidates the run. The reload between runs releases the lock
 * and so does a hidden page, so every page load and every return to the page asks again; so does a
 * lock the browser drops while the page stays visible (low battery), through `onLost`. Returns why
 * the lock was not granted, or "" when it was.
 */
async function keepScreenOn(state: SequenceState, onLost: () => void): Promise<string> {
  if (!("wakeLock" in navigator)) return "this browser has none";
  // A browser that keeps dropping the lock must not make the page ask in a loop.
  if (screenLockRequests <= 0) return "the browser keeps releasing it";
  screenLockRequests--;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    // Paused while the request was pending: let the screen sleep.
    if (state.status !== "running") {
      void sentinel.release();
      return "";
    }
    const previous = screenLock;
    screenLock = sentinel;
    void previous?.release();
    sentinel.addEventListener("release", () => {
      // Locks this page released itself (replaced, or paused in render) are no longer current.
      if (screenLock !== sentinel) return;
      screenLock = null;
      // A hidden page asks again when it becomes visible.
      if (state.status === "running" && document.visibilityState === "visible") onLost();
    });
    return "";
  } catch (error) {
    // Refused, such as by battery saver or a hidden page.
    return String(error);
  }
}

/** Median callback interval over about a second, as a refresh-rate suggestion. */
async function detectRefreshHz(): Promise<number> {
  const intervals: number[] = [];
  let last: number | undefined;
  await new Promise<void>((resolve) => {
    const frame = (now: number) => {
      if (last !== undefined) intervals.push(now - last);
      last = now;
      if (intervals.length >= 60) resolve();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  intervals.sort((a, b) => a - b);
  // A coarse clock can report equal timestamps; suggest 60 Hz rather than Infinity.
  const median = intervals[Math.floor(intervals.length / 2)];
  return median > 0 ? Math.round(1000 / median) : 60;
}

async function environment(): Promise<RunEnvironment> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean; level: number }> };
  let battery: RunEnvironment["battery"] = null;
  try {
    const value = await nav.getBattery?.();
    if (value) battery = { charging: value.charging, level: value.level };
  } catch {
    // Not offered (Firefox, Safari) or refused: recorded as unknown.
  }
  const memory = (performance as Performance & { memory?: RunEnvironment["memory"] }).memory;
  return { startedAt: new Date().toISOString(), battery,
    memory: memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : null };
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Revoking too early can cancel the download in Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function showResults(state: SequenceState): void {
  if (!state.results.length) return;
  const json = JSON.stringify({ conditions: state.conditions, refreshHz: state.refreshHz, commit: state.commit, config: state.config,
    schedules: state.schedules, results: state.results }, null, 1);
  const ledger = ledgerMarkdown(state.results, state.commit);
  $("#output").hidden = false;
  $<HTMLTextAreaElement>("#json").value = json;
  $<HTMLTextAreaElement>("#ledger").value = ledger;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  $("#download-json").onclick = () => download(`gpu-sequence-${stamp}.json`, json, "application/json");
  $("#download-ledger").onclick = () => download(`gpu-sequence-${stamp}.md`, ledger, "text/markdown");
}

/** Browser full screen (F11) makes the window the size of the screen; phones may never report it. */
const isFullScreen = () => innerWidth >= screen.width && innerHeight >= screen.height;

function confirmViewport(state: SequenceState, viewport: Viewport): void {
  state.readyViewport = viewport;
  state.readySize = [innerWidth, innerHeight];
}

/**
 * Whether the window suits the next run's viewport: confirmed by the person, or detected. Otherwise
 * pause and say what to change; Continue confirms it where detection cannot (phones). A full-screen
 * confirmation holds only while the window keeps its size, so leaving full screen or rotating a
 * phone between runs pauses again instead of running full-screen runs in a smaller window.
 */
function viewportReady(state: SequenceState, viewport: Viewport): boolean {
  if (state.readyViewport === "full" && (state.readySize?.[0] !== innerWidth || state.readySize?.[1] !== innerHeight)) state.readyViewport = null;
  if (state.readyViewport !== viewport && (viewport === "full" ? isFullScreen() : !isFullScreen() && innerWidth >= 960 && innerHeight >= 640)) {
    confirmViewport(state, viewport);
  }
  if (state.readyViewport === viewport) return true;
  state.status = "paused";
  state.message = viewport === "full"
    ? "Next: full-screen runs. Make the browser full screen (F11), then press Continue."
    : "Next: 960×640 runs. Leave full screen and make the window at least 960×640, then press Continue.";
  save(state);
  return false;
}

async function runNext(state: SequenceState): Promise<void> {
  const spec = state.plan[state.next];
  if (!viewportReady(state, spec.viewport)) return render(state);
  if (spec.viewport === "960x640" && (innerWidth < 960 || innerHeight < 640)) {
    state.readyViewport = null;
    state.status = "paused";
    state.message = `The window is ${innerWidth}×${innerHeight}; make it at least 960×640, then press Continue.`;
    save(state);
    return render(state);
  }
  document.body.className = `running ${spec.viewport === "full" ? "full" : "small"}`;
  document.title = `Run ${state.next + 1}/${state.plan.length}: ${spec.workload} ${spec.backend}`;
  // Let the canvas take its size before the run reads it.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const env = await environment();
  const schedule = state.schedules[spec.viewport];
  try {
    if (spec.kind === "schedule" && !schedule) throw new Error("No discovery schedule for this viewport: its discovery failed");
    const result = await runGpuBenchmark({
      backend: spec.backend, scenario: spec.scenario, refreshHz: state.refreshHz, conditions: state.conditions,
      warmupSeconds: spec.scenario === "drained" ? Math.max(60, state.config.warmupSeconds) : state.config.warmupSeconds,
      measureSeconds: state.config.measureSeconds,
      crossValidate: !state.config.cpuOnly,
      ...(spec.kind === "fixed" ? { limit: spec.limit } : spec.kind === "discovery" ? { budget: "adaptive" as const } : { schedule, scenario: undefined }),
    });
    if (spec.kind === "discovery" && result.schedule) state.schedules[spec.viewport] = result.schedule;
    state.results.push(summarizeRun(spec, result, env));
  } catch (error) {
    state.results.push({ spec, ok: false, error: String(error), startedAt: env.startedAt });
  }
  state.next++;
  if (state.next === state.plan.length) state.status = "done";
  if (save(state) && state.status === "running") location.reload();
  else {
    document.body.className = "";
    render(state);
  }
}

function render(state: SequenceState | null): void {
  void screenLock?.release();
  screenLock = null;
  document.body.className = "";
  document.title = "GPU comparison sequence";
  $("#actions").replaceChildren();
  $("#setup").hidden = state !== null;
  if (!state) return setup();
  const failed = state.results.filter((result) => !result.ok).length;
  const progress = `${state.next}/${state.plan.length} runs done${failed ? `, ${failed} failed` : ""}.`;
  if (state.status === "done") status(`Sequence complete: ${progress} Send the JSON or ledger rows for the result ledger.`);
  else if (state.status === "paused") status(`${state.message || "Paused."} ${progress}`, true);
  if (state.status !== "done") {
    button("Continue", () => {
      state.status = "running";
      confirmViewport(state, state.plan[state.next].viewport);
      state.message = "";
      if (save(state)) location.reload();
      else render(state);
    });
  }
  const failures = state.results.filter((result): result is FailedRun => !result.ok);
  if (failures.length && state.status !== "running") {
    button(`Retry ${failures.length} failed run(s)`, () => {
      state.results = state.results.filter((result) => result.ok);
      // Discoveries first, so retried replays can find their schedule.
      const retry = failures.map((run) => run.spec).sort((a, b) => Number(b.kind === "discovery") - Number(a.kind === "discovery"));
      for (const spec of retry) state.plan.push({ ...spec, index: state.plan.length });
      state.status = "running";
      state.readyViewport = null;
      if (save(state)) location.reload();
      else render(state);
    });
  }
  button("Reset", () => {
    if (!confirm("Delete the plan and every stored summary? Download them first if you need them.")) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
  showResults(state);
}

function setup(): void {
  const form = $<HTMLFormElement>("#setup");
  status(window.isSecureContext ? "" : INSECURE, !window.isSecureContext);
  form.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = !window.isSecureContext;
  $("#workloads").replaceChildren(...WORKLOADS.map((workload) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    Object.assign(input, { type: "checkbox", name: "workload", value: workload, checked: DEFAULT_WORKLOADS.includes(workload) });
    label.append(input, ` ${workload}`);
    return label;
  }));
  const config = (): SequenceConfig => {
    const data = new FormData(form);
    return {
      viewports: data.getAll("viewport") as Viewport[],
      workloads: data.getAll("workload") as SequenceConfig["workloads"],
      repetitions: Number(data.get("repetitions")),
      scheduleReplays: data.get("scheduleReplays") === "on",
      cpuOnly: data.get("gpu") !== "on",
      warmupSeconds: Number(data.get("warmupSeconds")),
      measureSeconds: Number(data.get("measureSeconds")),
    };
  };
  const estimate = () => {
    try {
      const plan = buildRunPlan(config());
      $("#estimate").textContent = `${plan.length} runs, about ${estimateMinutes(plan, config())} minutes. Keep the tab visible, the screen awake and the machine otherwise idle.`;
    } catch (error) {
      $("#estimate").textContent = String(error);
    }
  };
  form.addEventListener("input", estimate);
  estimate();
  void detectRefreshHz().then((hz) => {
    $("#detected").textContent = `detected about ${hz} Hz`;
    const input = form.elements.namedItem("refreshHz") as HTMLInputElement;
    if (!input.value) input.value = String(hz);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    let plan: RunSpec[];
    try {
      plan = buildRunPlan(config());
    } catch (error) {
      return status(String(error), true);
    }
    const state: SequenceState = { version: 1, config: config(), conditions: String(data.get("conditions")).trim(), refreshHz: Number(data.get("refreshHz")),
      commit: String(data.get("commit")).trim(), plan, next: 0, results: [], schedules: {}, status: "running", readyViewport: null, message: "" };
    if (!viewportReady(state, plan[0].viewport)) return render(state);
    if (save(state)) location.reload();
    else render(state);
  });
}

function main(): void {
  const state = load();
  if (state?.status !== "running") return render(state);
  if (!window.isSecureContext) {
    state.status = "paused";
    state.message = INSECURE;
    save(state);
    return render(state);
  }
  // A short window to stop between runs; pausing keeps everything stored.
  render(state);
  $("#actions").replaceChildren();
  let remaining = COUNTDOWN_SECONDS;
  const spec = state.plan[state.next];
  let screenNote = "";
  const tick = () => status(`Run ${state.next + 1}/${state.plan.length} (${spec.viewport}, ${spec.workload}, ${spec.backend}, repetition ${spec.repetition}) starts in ${remaining} s.${screenNote}`, screenNote !== "");
  // A refusal during the countdown shows at once; during a run the panel is hidden, but the next
  // page load asks again and its countdown reports a refusal that persists.
  // Requests can overlap (the page became visible while one was pending), so a refusal warns only
  // while no lock is held, whichever request settles last.
  const lock = (): void => void keepScreenOn(state, lock).then((reason) => {
    screenNote = reason && !screenLock ? ` No screen wake lock (${reason}): keep the screen on yourself.` : "";
    if (state.status === "running" && remaining > 0) tick();
  });
  lock();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.status === "running") lock();
  });
  tick();
  const timer = setInterval(() => {
    remaining--;
    if (remaining > 0) return tick();
    clearInterval(timer);
    void runNext(state);
  }, 1000);
  button("Pause", () => {
    clearInterval(timer);
    state.status = "paused";
    state.message = "Paused.";
    save(state);
    render(state);
  });
}

main();
