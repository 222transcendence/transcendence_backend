import { countKeystrokes } from '../game/acid-rain/keystroke-count';
import { SEED_WORDS } from './seed-words';

describe('word dictionary seed keystrokes', () => {
  it('uses the physical two-set keystroke calculator for every seed', () => {
    expect(SEED_WORDS.length).toBeGreaterThan(0);
    for (const word of SEED_WORDS) {
      expect(word.keystrokes).toBe(countKeystrokes(word.text));
    }
  });

  it.each([
    ['사과', 5],
    ['가을', 5],
    ['프로그래머', 10],
    ['다큐멘터리', 11],
  ])('calculates %s as %i physical keystrokes', (word, expected) => {
    expect(countKeystrokes(word)).toBe(expected);
  });
});
