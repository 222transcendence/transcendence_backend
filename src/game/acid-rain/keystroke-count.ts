/**
 * 게임 dictionary 문자열의 실제 physical keystroke 수를 계산한다.
 *
 * 완성형 한글은 2벌식(two-set) 입력 규칙을 사용하고, ASCII printable
 * 문자는 영문 대·소문자, 숫자, 공백, 문장부호 모두 한 타로 계산한다.
 * 제어문자와 지원하지 않는 Unicode 문자는 입력 데이터 오류로 명시적으로
 * 실패시킨다.
 */

const CHO = [
  'ㄱ',
  'ㄲ',
  'ㄴ',
  'ㄷ',
  'ㄸ',
  'ㄹ',
  'ㅁ',
  'ㅂ',
  'ㅃ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅉ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ',
] as const;

const JUNG = [
  'ㅏ',
  'ㅐ',
  'ㅑ',
  'ㅒ',
  'ㅓ',
  'ㅔ',
  'ㅕ',
  'ㅖ',
  'ㅗ',
  'ㅘ',
  'ㅙ',
  'ㅚ',
  'ㅛ',
  'ㅜ',
  'ㅝ',
  'ㅞ',
  'ㅟ',
  'ㅠ',
  'ㅡ',
  'ㅢ',
  'ㅣ',
] as const;

const JONG = [
  '',
  'ㄱ',
  'ㄲ',
  'ㄳ',
  'ㄴ',
  'ㄵ',
  'ㄶ',
  'ㄷ',
  'ㄹ',
  'ㄺ',
  'ㄻ',
  'ㄼ',
  'ㄽ',
  'ㄾ',
  'ㄿ',
  'ㅀ',
  'ㅁ',
  'ㅂ',
  'ㅄ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ',
] as const;

// 초성: 평자음 1타, 쌍자음(Shift+베이스) 2타
const CHO_KEYS: Record<string, number> = {
  ㄱ: 1,
  ㄲ: 2,
  ㄴ: 1,
  ㄷ: 1,
  ㄸ: 2,
  ㄹ: 1,
  ㅁ: 1,
  ㅂ: 1,
  ㅃ: 2,
  ㅅ: 1,
  ㅆ: 2,
  ㅇ: 1,
  ㅈ: 1,
  ㅉ: 2,
  ㅊ: 1,
  ㅋ: 1,
  ㅌ: 1,
  ㅍ: 1,
  ㅎ: 1,
};

// 중성: 단모음 12개 1타, ㅒㅖ는 Shift 필요 2타, 이중모음 7개는 베이스 모음
// 두 개를 순서대로 눌러 조합하므로 Shift 없이 2타
const JUNG_KEYS: Record<string, number> = {
  ㅏ: 1,
  ㅑ: 1,
  ㅓ: 1,
  ㅕ: 1,
  ㅗ: 1,
  ㅛ: 1,
  ㅜ: 1,
  ㅠ: 1,
  ㅡ: 1,
  ㅣ: 1,
  ㅐ: 1,
  ㅔ: 1,
  ㅒ: 2,
  ㅖ: 2,
  ㅘ: 2,
  ㅙ: 2,
  ㅚ: 2,
  ㅝ: 2,
  ㅞ: 2,
  ㅟ: 2,
  ㅢ: 2,
};

// 종성: 없음 0, 홑받침(평자음과 동일 키) 1타, ㄲㅆ 쌍자음 받침 2타(Shift),
// 겹받침 11개(서로 다른 두 평자음 조합) 2타(Shift 아님)
const JONG_KEYS: Record<string, number> = {
  '': 0,
  ㄱ: 1,
  ㄴ: 1,
  ㄷ: 1,
  ㄹ: 1,
  ㅁ: 1,
  ㅂ: 1,
  ㅅ: 1,
  ㅇ: 1,
  ㅈ: 1,
  ㅊ: 1,
  ㅋ: 1,
  ㅌ: 1,
  ㅍ: 1,
  ㅎ: 1,
  ㄲ: 2,
  ㅆ: 2,
  ㄳ: 2,
  ㄵ: 2,
  ㄶ: 2,
  ㄺ: 2,
  ㄻ: 2,
  ㄼ: 2,
  ㄽ: 2,
  ㄾ: 2,
  ㄿ: 2,
  ㅀ: 2,
  ㅄ: 2,
};

const S_BASE = 0xac00;
const S_LAST = 0xd7a3;
const ASCII_PRINTABLE_MIN = 0x20;
const ASCII_PRINTABLE_MAX = 0x7e;

/**
 * 게임 dictionary 문자열의 2벌식/ASCII physical keystroke 횟수를 반환한다.
 */
export function countKeystrokes(word: string): number {
  let total = 0;
  for (const ch of word) {
    const code = ch.codePointAt(0)!;
    if (code >= ASCII_PRINTABLE_MIN && code <= ASCII_PRINTABLE_MAX) {
      total += 1;
      continue;
    }
    if (code < S_BASE || code > S_LAST) {
      throw new Error(`Unsupported dictionary character: "${ch}" in "${word}"`);
    }
    const offset = code - S_BASE;
    const cho = CHO[Math.floor(offset / (21 * 28))];
    const jung = JUNG[Math.floor((offset % (21 * 28)) / 28)];
    const jong = JONG[offset % 28];
    total += CHO_KEYS[cho] + JUNG_KEYS[jung] + JONG_KEYS[jong];
  }
  return total;
}
