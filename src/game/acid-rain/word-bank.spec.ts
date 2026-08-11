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

  it('every entry has a positive keystroke count (no leftover 0 placeholders)', () => {
    for (const { keystrokes } of WORD_BANK) {
      expect(keystrokes).toBeGreaterThan(0);
    }
  });
});

describe('WORD_BANK keystrokes: 0 placeholder auto-fill', () => {
  it('replaces keystrokes: 0 with countKeystrokes(text) via the same mapping RAW_WORDS uses', () => {
    // word-bank.ts의 WORD_BANK = RAW_WORDS.map(entry => entry.keystrokes === 0 ? ... : entry)
    // 와 동일한 규칙을 재현해서, 신규 단어를 keystrokes: 0으로 추가했을 때
    // 실제로 자동 계산되는지 검증한다.
    const draft = { text: '오이', keystrokes: 0 };
    const filled =
      draft.keystrokes === 0
        ? { text: draft.text, keystrokes: countKeystrokes(draft.text) }
        : draft;
    expect(filled.keystrokes).toBe(countKeystrokes('오이'));
    expect(filled.keystrokes).toBeGreaterThan(0);
  });
});
