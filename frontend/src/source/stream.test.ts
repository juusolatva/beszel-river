import { describe, it, expect } from 'vitest';
import { parseFrame } from './stream';
import { FILAMENTS } from '../sim/streams';

describe('parseFrame', () => {
  it('should return null for non-JSON string', () => {
    expect(parseFrame('not a json string')).toBeNull();
  });

  it('should return null if parsed data is not an object', () => {
    expect(parseFrame('null')).toBeNull();
    expect(parseFrame('123')).toBeNull();
    expect(parseFrame('[]')).toBeNull();
  });

  it('should return null if version v is not 1', () => {
    expect(parseFrame(JSON.stringify({ v: 2, t: 123, streams: [] }))).toBeNull();
    expect(parseFrame(JSON.stringify({ t: 123, streams: [] }))).toBeNull();
  });

  it('should return null if time t is not a number', () => {
    expect(parseFrame(JSON.stringify({ v: 1, t: '123', streams: [] }))).toBeNull();
    expect(parseFrame(JSON.stringify({ v: 1, streams: [] }))).toBeNull();
  });

  it('should return null if streams is not an array', () => {
    expect(parseFrame(JSON.stringify({ v: 1, t: 123, streams: {} }))).toBeNull();
    expect(parseFrame(JSON.stringify({ v: 1, t: 123 }))).toBeNull();
  });

  it('should parse valid frame correctly', () => {
    const data = {
      v: 1,
      t: 1000,
      streams: [
        {
          id: 'test-1',
          alive: true,
          width: 0.8,
          flow: 0.5,
          density: 0.2,
          turbulence: 0.1,
          pulse: 0.9,
          heat: 0.4
        }
      ]
    };
    const expected = {
      v: 1,
      t: 1000,
      streams: [
        {
          id: 'test-1',
          alive: true,
          width: 0.8,
          flow: 0.5,
          density: 0.2,
          turbulence: 0.1,
          pulse: 0.9,
          heat: 0.4
        }
      ]
    };
    expect(parseFrame(JSON.stringify(data))).toEqual(expected);
  });

  it('should skip invalid streams in array', () => {
    const data = {
      v: 1,
      t: 1000,
      streams: [
        { id: 'test-1', alive: true },
        'not a stream object',
        null,
        { alive: true } // missing id
      ]
    };
    const result = parseFrame(JSON.stringify(data));
    expect(result?.streams.length).toBe(1);
    expect(result?.streams[0].id).toBe('test-1');
  });

  it('should clamp channel values', () => {
    const data = {
      v: 1,
      t: 1000,
      streams: [
        {
          id: 'test-1',
          width: 1.5, // > 1
          flow: -0.5 // < 0
        }
      ]
    };
    const result = parseFrame(JSON.stringify(data));
    expect(result?.streams[0].width).toBe(1);
    expect(result?.streams[0].flow).toBe(0);
  });

  it('should preserve filaments array if it has expected length and finite numbers', () => {
    const filaments = Array.from({ length: FILAMENTS }, () => 0.5);
    const data = {
      v: 1,
      t: 1000,
      streams: [
        {
          id: 'test-1',
          filaments
        }
      ]
    };
    const result = parseFrame(JSON.stringify(data));
    expect(result?.streams[0].filaments).toEqual(filaments);
  });

  it('should clamp filaments values', () => {
    const filaments = Array.from({ length: FILAMENTS }, (_, i) => i === 0 ? 1.5 : (i === 1 ? -0.5 : 0.5));
    const data = {
      v: 1,
      t: 1000,
      streams: [
        {
          id: 'test-1',
          filaments
        }
      ]
    };
    const result = parseFrame(JSON.stringify(data));
    expect(result?.streams[0].filaments?.[0]).toBe(1);
    expect(result?.streams[0].filaments?.[1]).toBe(0);
    expect(result?.streams[0].filaments?.[2]).toBe(0.5);
  });

  it('should drop filaments array if it does not match expected length', () => {
    const filaments = [0.5, 0.5]; // wrong length
    const data = {
      v: 1,
      t: 1000,
      streams: [
        {
          id: 'test-1',
          filaments
        }
      ]
    };
    const result = parseFrame(JSON.stringify(data));
    expect(result?.streams[0].filaments).toBeUndefined();
  });

  it('should drop filaments array if it contains non-finite numbers', () => {
    const filaments = Array.from({ length: FILAMENTS }, () => 0.5);
    filaments[0] = Infinity;
    const data = {
      v: 1,
      t: 1000,
      streams: [
        {
          id: 'test-1',
          filaments
        }
      ]
    };
    const result = parseFrame(JSON.stringify(data));
    expect(result?.streams[0].filaments).toBeUndefined();
  });
});
