import { createHangulTypingSnapshots, normalizeImeText } from './hangul-ime';

describe('deterministic Korean 2-set IME', () => {
  it.each([
    ['가나', ['ㄱ', '가', '간', '가나']],
    ['값', ['ㄱ', '가', '갑', '값']],
    ['과', ['ㄱ', '고', '과']],
    ['왜', ['ㅇ', '오', '왜']],
    ['때', ['ㄷ', 'ㄸ', '때']],
    ['얘', ['ㅇ', '애', '얘']],
  ])('creates physical-key snapshots for %s', (text, expected) => {
    expect(createHangulTypingSnapshots(text)).toEqual(expected);
  });

  it('handles mixed text, empty text, and unsupported characters safely', () => {
    expect(createHangulTypingSnapshots('')).toEqual([]);
    expect(createHangulTypingSnapshots('한글42!').at(-1)).toBe('한글42!');
    expect(createHangulTypingSnapshots('🙂').at(-1)).toBe('🙂');
  });

  it('normalizes decomposed Unicode before composing', () => {
    const decomposed = '가나';
    expect(normalizeImeText(decomposed)).toBe('가나');
    expect(createHangulTypingSnapshots(decomposed).at(-1)).toBe('가나');
  });

  it('supports long input without losing the final text', () => {
    const text = '가나다라마바사아자차카타파하'.repeat(20);
    const snapshots = createHangulTypingSnapshots(text);
    expect(snapshots.at(-1)).toBe(text);
    expect(snapshots.length).toBeGreaterThan(text.length);
  });

  it('composes every precomposed Hangul syllable exactly', () => {
    for (let codePoint = 0xac00; codePoint <= 0xd7a3; codePoint += 1) {
      const text = String.fromCodePoint(codePoint);
      expect(createHangulTypingSnapshots(text).at(-1)).toBe(text);
    }
  });
});
