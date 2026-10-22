import type { Frame } from "@beszel-river/shared";

/** Delivers frames from the bridge (`StreamSource`) or generated ones (`DemoSource`). */
export interface FrameSource {
  start(onFrame: (frame: Frame) => void): void;
  stop(): void;
}
