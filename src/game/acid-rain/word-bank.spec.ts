import { WORD_BANK } from './word-bank';
import { countKeystrokes } from './keystroke-count';

describe('WORD_BANK', () => {
  it('has between 300 and 500 entries (GAME_DESIGN.md §3.2)', () => {
    expect(WORD_BANK.length).toBeGreaterThanOrEqual(300);
    expect(WORD_BANK.length).toBeLessThanOrEqual(500);
  });

  it('has no duplicate words', () => {
    const texts = WORD_BANK.map((w) => w.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('has no empty words', () => {
    for (const { text } of WORD_BANK) {
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('has a keystroke count matching countKeystrokes(text) for every entry', () => {
    for (const { text, keystrokes } of WORD_BANK) {
      expect(keystrokes).toBe(countKeystrokes(text));
    }
  });

  it('every entry has a positive keystroke count', () => {
    for (const { keystrokes } of WORD_BANK) {
      expect(keystrokes).toBeGreaterThan(0);
    }
  });
});
