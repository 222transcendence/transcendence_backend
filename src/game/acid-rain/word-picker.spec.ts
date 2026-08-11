import { pickWord, __testing } from './word-picker';

const { LOW_POOL, MID_POOL, HIGH_POOL, LOW_MID_POOL } = __testing;

describe('word bucket pools (GAME_DESIGN.md §3.2)', () => {
  it('partitions every word into exactly one of LOW/MID/HIGH by keystrokes', () => {
    for (const w of LOW_POOL) expect(w.keystrokes).toBeLessThanOrEqual(5);
    for (const w of MID_POOL) {
      expect(w.keystrokes).toBeGreaterThan(5);
      expect(w.keystrokes).toBeLessThanOrEqual(9);
    }
    for (const w of HIGH_POOL) expect(w.keystrokes).toBeGreaterThan(9);
    expect(LOW_POOL.length + MID_POOL.length + HIGH_POOL.length).toBe(
      LOW_MID_POOL.length + HIGH_POOL.length,
    );
  });

  it('all pools are non-empty (word bank has coverage across every bucket)', () => {
    expect(LOW_POOL.length).toBeGreaterThan(0);
    expect(MID_POOL.length).toBeGreaterThan(0);
    expect(HIGH_POOL.length).toBeGreaterThan(0);
  });
});

describe('pickWord elapsed-time weighting (GAME_DESIGN.md §3.4)', () => {
  it('0~30s: only draws from LOW', () => {
    for (let i = 0; i < 200; i++) {
      const word = pickWord(Math.random() * 30);
      expect(word.keystrokes).toBeLessThanOrEqual(5);
    }
  });

  it('at exactly 30s: switches to LOW+MID', () => {
    const draws = Array.from({ length: 300 }, () => pickWord(30));
    expect(draws.some((w) => w.keystrokes > 5)).toBe(true);
    expect(draws.every((w) => w.keystrokes <= 9)).toBe(true);
  });

  it('30~90s: only draws from LOW+MID, never HIGH', () => {
    for (let i = 0; i < 300; i++) {
      const word = pickWord(30 + Math.random() * 60);
      expect(word.keystrokes).toBeLessThanOrEqual(9);
    }
  });

  it('at exactly 90s: HIGH becomes reachable', () => {
    const draws = Array.from({ length: 500 }, () => pickWord(90));
    expect(draws.some((w) => w.keystrokes > 9)).toBe(true);
  });

  it('90s+: draws from all three buckets', () => {
    const draws = Array.from({ length: 500 }, () => pickWord(150));
    expect(draws.some((w) => w.keystrokes <= 5)).toBe(true);
    expect(draws.some((w) => w.keystrokes > 5 && w.keystrokes <= 9)).toBe(true);
    expect(draws.some((w) => w.keystrokes > 9)).toBe(true);
  });
});
