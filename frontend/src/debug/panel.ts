import type { Channel } from "@beszel-river/shared";
import { CHANNELS, type DemoSource, type DemoStream } from "../source/demo";

export interface Stats {
  fps: number;
  particles: number;
  simMs: number;
}

const STYLE = `
.debug { position: fixed; top: 8px; left: 8px; max-height: calc(100vh - 16px); overflow: auto; padding: 8px;
  background: rgb(0 0 0 / 0.7); color: #ddd; font: 11px/1.4 ui-monospace, monospace; border-radius: 4px; }
.debug .stream { margin-top: 8px; }
.debug label { display: grid; grid-template-columns: 80px 120px 32px; align-items: center; }
.debug button { font: inherit; margin-right: 4px; }
`;

/** Demo controls (`?debug`): per-stream channel sliders, add/remove streams, stats. `d` toggles it. */
export function mountDebugPanel(demo: DemoSource, stats: Stats): void {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  const panel = document.createElement("div");
  panel.className = "debug";
  const header = document.createElement("div");
  const buttons = document.createElement("div");
  const list = document.createElement("div");
  panel.append(header, buttons, list);
  document.body.append(panel);

  const button = (text: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.textContent = text;
    b.addEventListener("click", () => {
      onClick();
      build();
    });
    return b;
  };
  buttons.append(
    button("+ stream", () => demo.addStream()),
    button("− stream", () => demo.removeStream()),
  );

  let sliders: { stream: DemoStream; channel: Channel; input: HTMLInputElement; value: HTMLSpanElement }[] = [];

  function build(): void {
    sliders = [];
    list.replaceChildren(...demo.streams.map(row));
  }

  function checkbox(text: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
    const label = document.createElement("label");
    label.style.display = "inline";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    label.append(input, ` ${text} `);
    return label;
  }

  function row(stream: DemoStream): HTMLElement {
    const box = document.createElement("div");
    box.className = "stream";
    const title = document.createElement("div");
    const hold = checkbox("hold", stream.held, (checked) => (stream.held = checked));
    title.append(
      `${stream.id} `,
      checkbox("alive", stream.alive, (checked) => {
        stream.alive = checked;
        demo.emit();
      }),
      hold,
    );
    box.append(title);

    for (const channel of CHANNELS) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "0.01";
      input.value = String(stream.values[channel]);
      const value = document.createElement("span");
      input.addEventListener("input", () => {
        stream.held = true;
        (hold.firstChild as HTMLInputElement).checked = true;
        stream.values[channel] = Number(input.value);
        demo.emit();
      });
      label.append(channel, input, value);
      box.append(label);
      sliders.push({ stream, channel, input, value });
    }
    return box;
  }

  build();
  setInterval(() => {
    header.textContent = `${stats.fps.toFixed(0)} fps · ${stats.particles} particles · sim ${stats.simMs.toFixed(1)} ms`;
    for (const s of sliders) {
      const v = s.stream.values[s.channel];
      if (document.activeElement !== s.input) s.input.value = String(v);
      s.value.textContent = v.toFixed(2);
    }
  }, 250);

  addEventListener("keydown", (event) => {
    if (event.key === "d") panel.hidden = !panel.hidden;
  });
}
