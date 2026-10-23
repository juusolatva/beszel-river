import { describe, expect, test } from "vitest";
import { parseFrame } from "../src/source/stream";
import { FILAMENTS } from "../src/sim/streams";

describe("parseFrame", () => {
  test("returns null for non-JSON string", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  test("returns null for invalid top-level structures", () => {
    expect(parseFrame("{}")).toBeNull();
    expect(parseFrame("null")).toBeNull();
    expect(parseFrame("[]")).toBeNull();
    expect(parseFrame('{"v":2,"t":100,"streams":[]}')).toBeNull(); // Wrong version
    expect(parseFrame('{"v":1,"t":"100","streams":[]}')).toBeNull(); // t is not a number
    expect(parseFrame('{"v":1,"t":100,"streams":{}}')).toBeNull(); // streams is not an array
  });

  test("parses valid frame with no streams", () => {
    const frame = parseFrame('{"v":1,"t":100,"streams":[]}');
    expect(frame).toEqual({ v: 1, t: 100, streams: [] });
  });

  test("parses valid frame with a stream, applying defaults and clamping", () => {
    const json = JSON.stringify({
      v: 1,
      t: 100,
      streams: [
        {
          id: "stream-1",
          alive: true,
          width: 2.5, // Should clamp to 1
          flow: -1, // Should clamp to 0
          // missing other channels, should use defaults
        }
      ]
    });

    const frame = parseFrame(json);
    expect(frame?.streams[0]).toEqual({
      id: "stream-1",
      alive: true,
      width: 1,
      flow: 0,
      density: 0,
      turbulence: 0,
      pulse: 0,
      heat: 0.5,
    });
  });

  test("ignores streams that are not objects or missing id", () => {
    const json = JSON.stringify({
      v: 1,
      t: 100,
      streams: [
        null,
        "not an object",
        { alive: true }, // missing id
        { id: "valid" }
      ]
    });
    const frame = parseFrame(json);
    expect(frame?.streams.length).toBe(1);
    expect(frame?.streams[0].id).toBe("valid");
  });

  test("handles filaments properly", () => {
    const validFilaments = Array(FILAMENTS).fill(0.5);
    validFilaments[0] = -1; // Should clamp to 0
    validFilaments[1] = 2;  // Should clamp to 1

    const json = JSON.stringify({
      v: 1,
      t: 100,
      streams: [
        {
          id: "stream-1",
          filaments: validFilaments
        },
        {
          id: "stream-2",
          filaments: [0.5, 0.5] // Wrong length, should be ignored
        }
      ]
    });

    const frame = parseFrame(json);

    // Filament clamping check
    expect(frame?.streams[0].filaments).toBeDefined();
    expect(frame?.streams[0].filaments?.[0]).toBe(0);
    expect(frame?.streams[0].filaments?.[1]).toBe(1);
    expect(frame?.streams[0].filaments?.[2]).toBe(0.5);

    // Wrong length should ignore filaments but keep stream
    expect(frame?.streams[1].filaments).toBeUndefined();
  });
});
