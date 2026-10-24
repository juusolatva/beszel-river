import { describe, expect, it } from "vitest";
import { FILAMENTS } from "../src/sim/streams";
import { parseFrame } from "../src/source/stream";

describe("parseFrame", () => {
  it("rejects malformed JSON and frames that are not v1", () => {
    for (const bad of ["", "not json", "null", "[]", "{}", '{"v":2,"t":1,"streams":[]}', '{"v":1,"t":"1","streams":[]}', '{"v":1,"t":1,"streams":{}}']) {
      expect(parseFrame(bad)).toBeNull();
    }
  });

  it("clamps channels, fills defaults, and skips invalid stream entries", () => {
    const frame = parseFrame(
      JSON.stringify({
        v: 1,
        t: 100,
        streams: [null, "bad", { alive: true }, { id: "a", alive: true, width: 2.5, flow: -1, density: NaN }],
      }),
    );
    expect(frame).toEqual({
      v: 1,
      t: 100,
      streams: [{ id: "a", alive: true, width: 1, flow: 0, density: 0, turbulence: 0, pulse: 0, heat: 0.5 }],
    });
  });

  it("keeps and clamps filaments only when there are 6 finite numbers", () => {
    const valid = [-1, 0.2, 0.4, 0.6, 0.8, 2];
    expect(FILAMENTS).toBe(6);
    const frame = parseFrame(
      JSON.stringify({
        v: 1,
        t: 100,
        streams: [
          { id: "ok", filaments: valid },
          { id: "short", filaments: [0.5, 0.5] },
          { id: "nan", filaments: [0, 0, 0, 0, 0, "x"] },
        ],
      }),
    );
    expect(frame?.streams[0]?.filaments).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(frame?.streams[1]?.filaments).toBeUndefined();
    expect(frame?.streams[2]?.filaments).toBeUndefined();
  });
});
