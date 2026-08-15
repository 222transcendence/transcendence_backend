import { countKeystrokes } from './keystroke-count';

describe('countKeystrokes', () => {
  it.each([
    ['가', 2], // ㄱ(1) + ㅏ(1)
    ['산', 3], // ㅅ(1) + ㅏ(1) + ㄴ(1)
    ['값', 4], // ㄱ(1) + ㅏ(1) + ㅄ(2, 겹받침)
    ['닭', 4], // ㄷ(1) + ㅏ(1) + ㄺ(2, 겹받침)
    ['꽃', 4], // ㄲ(2, 쌍자음 Shift) + ㅗ(1) + ㅊ(1)
    ['쌀', 4], // ㅆ(2, 쌍자음 Shift) + ㅏ(1) + ㄹ(1)
    ['왜', 3], // ㅇ(1) + ㅙ(2, 이중모음)
    ['의', 3], // ㅇ(1) + ㅢ(2, 이중모음)
    ['얘', 3], // ㅇ(1) + ㅒ(2, Shift 모음)
  ])('%s -> %d keystrokes', (word, expected) => {
    expect(countKeystrokes(word)).toBe(expected);
  });

  it('sums keystrokes across multi-syllable words', () => {
    // 사과: ㅅ(1)+ㅏ(1) + ㄱ(1)+ㅘ(2) = 5
    expect(countKeystrokes('사과')).toBe(5);
  });

  it.each([
    ['SF', 2],
    ['aZ', 2],
    ['09', 2],
    ['가A1', 4],
    ['Hello, 42!', 10],
    ["'()[]{}!?", 9],
  ])('counts ASCII and mixed text: %s -> %d', (word, expected) => {
    expect(countKeystrokes(word)).toBe(expected);
  });

  it.each(['가\n', '가😀', '가'])(
    'rejects unsupported characters: %s',
    (word) => {
      expect(() => countKeystrokes(word)).toThrow(
        'Unsupported dictionary character',
      );
    },
  );
});
