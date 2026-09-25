import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersionSegments } from './version';

describe('version utilities', () => {
  it('parses version segments correctly', () => {
    expect(parseVersionSegments('v1.13.0')).toEqual([1, 13, 0]);
    expect(parseVersionSegments('v1.14.0-旧面板-hasuki')).toEqual([1, 14, 0]);
    expect(parseVersionSegments('v1.11.12-hasuki')).toEqual([1, 11, 12]);
  });

  it('compares latest with current versions properly', () => {
    // Current is caught up to latest v1.14.0
    expect(compareVersions('v1.14.0', 'v1.14.0-旧面板-hasuki')).toBe(0);
    // When latest was v1.14.0 and current was v1.11.12
    expect(compareVersions('v1.14.0', 'v1.11.12-hasuki')).toBe(1);
    // When current is ahead of latest
    expect(compareVersions('v1.13.2', 'v1.14.0-旧面板-hasuki')).toBe(-1);
  });
});
