import { expect, it } from "vitest";
import * as layout from "../src/sim/gpu-layout";

it("fixes the shared float/integer feedback layout at 64 bytes", () => {
  expect([layout.GPU_STATE_STRIDE_BYTES, layout.GPU_MOTION_OFFSET_BYTES, layout.GPU_LIFETIME_OFFSET_BYTES,
    layout.GPU_SPAWN_OFFSET_BYTES, layout.GPU_IDENTITY_OFFSET_BYTES]).toEqual([64, 0, 16, 32, 48]);
  expect(layout.GPU_FEEDBACK_VARYINGS).toEqual(["v_motion", "v_lifetime", "v_spawn", "v_identity"]);
});
