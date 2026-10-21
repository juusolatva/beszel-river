import type { Frame } from "@beszel-river/shared";

/** Delivers frames from the bridge (`StreamSource`, M4) or generated ones (`DemoSource`). */
export interface FrameSource {
  start(onFrame: (frame: Frame) => void): void;
  stop(): void;
}
