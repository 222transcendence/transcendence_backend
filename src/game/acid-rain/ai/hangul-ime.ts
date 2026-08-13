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
];
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
];
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
];
const INITIAL_KEYS: Record<string, string> = {
  ㄱ: 'r',
  ㄲ: 'rr',
  ㄴ: 's',
  ㄷ: 'e',
  ㄸ: 'ee',
  ㄹ: 'f',
  ㅁ: 'a',
  ㅂ: 'q',
  ㅃ: 'qq',
  ㅅ: 't',
  ㅆ: 'tt',
  ㅇ: 'd',
  ㅈ: 'w',
  ㅉ: 'ww',
  ㅊ: 'c',
  ㅋ: 'z',
  ㅌ: 'x',
  ㅍ: 'v',
  ㅎ: 'g',
};
const VOWEL_KEYS: Record<string, string> = {
  ㅏ: 'k',
  ㅐ: 'o',
  ㅑ: 'i',
  ㅒ: 'oo',
  ㅓ: 'j',
  ㅔ: 'p',
  ㅕ: 'u',
  ㅖ: 'pp',
  ㅗ: 'h',
  ㅘ: 'hk',
  ㅙ: 'ho',
  ㅚ: 'hl',
  ㅛ: 'y',
  ㅜ: 'n',
  ㅝ: 'nj',
  ㅞ: 'np',
  ㅟ: 'nl',
  ㅠ: 'b',
  ㅡ: 'm',
  ㅢ: 'ml',
  ㅣ: 'l',
};
const FINAL_KEYS: Record<string, string> = {
  ...INITIAL_KEYS,
  ㄳ: 'rt',
  ㄵ: 'sw',
  ㄶ: 'sg',
  ㄺ: 'fr',
  ㄻ: 'fa',
  ㄼ: 'fq',
  ㄽ: 'ft',
  ㄾ: 'fx',
  ㄿ: 'fv',
  ㅀ: 'fg',
  ㅄ: 'qt',
};
const KEY_TO_JAMO = new Map<string, string>();
const FINAL_COMBINATIONS: Record<string, string> = {
  ㄱㄱ: 'ㄲ',
  ㄱㅅ: 'ㄳ',
  ㄴㅈ: 'ㄵ',
  ㄴㅎ: 'ㄶ',
  ㄹㄱ: 'ㄺ',
  ㄹㅁ: 'ㄻ',
  ㄹㅂ: 'ㄼ',
  ㄹㅅ: 'ㄽ',
  ㄹㅌ: 'ㄾ',
  ㄹㅍ: 'ㄿ',
  ㄹㅎ: 'ㅀ',
  ㅂㅅ: 'ㅄ',
  ㅅㅅ: 'ㅆ',
};
const INITIAL_COMBINATIONS: Record<string, string> = {
  ㄱㄱ: 'ㄲ',
  ㄷㄷ: 'ㄸ',
  ㅂㅂ: 'ㅃ',
  ㅅㅅ: 'ㅆ',
  ㅈㅈ: 'ㅉ',
};
for (const [jamo, key] of Object.entries(INITIAL_KEYS))
  KEY_TO_JAMO.set(key, jamo);
for (const [jamo, key] of Object.entries(VOWEL_KEYS)) {
  if (key.length === 1) KEY_TO_JAMO.set(key, jamo);
}

const S_BASE = 0xac00;
const isConsonant = (value: string): boolean =>
  CHO.includes(value) || (value !== '' && JONG.includes(value));
const isVowel = (value: string): boolean => JUNG.includes(value);

function compose(cho: string, jung: string, jong = ''): string {
  const ci = CHO.indexOf(cho);
  const vi = JUNG.indexOf(jung);
  const fi = JONG.indexOf(jong);
  return ci >= 0 && vi >= 0 && fi >= 0
    ? String.fromCodePoint(S_BASE + (ci * 21 + vi) * 28 + fi)
    : cho + jung + jong;
}

function decomposeSyllable(character: string): string[] | undefined {
  const code = character.codePointAt(0) ?? 0;
  if (code < S_BASE || code > 0xd7a3) return undefined;
  const offset = code - S_BASE;
  return [
    CHO[Math.floor(offset / 588)],
    JUNG[Math.floor((offset % 588) / 28)],
    JONG[offset % 28],
  ];
}

function keySequenceFor(character: string): string | undefined {
  const parts = decomposeSyllable(character);
  if (!parts) return undefined;
  return (
    INITIAL_KEYS[parts[0]] +
    VOWEL_KEYS[parts[1]] +
    (parts[2] ? FINAL_KEYS[parts[2]] : '')
  );
}

interface Composer {
  committed: string;
  cho: string;
  jung: string;
  jong: string;
}

function render(composer: Composer): string {
  if (!composer.cho) return composer.committed;
  if (!composer.jung) return composer.committed + composer.cho;
  return (
    composer.committed + compose(composer.cho, composer.jung, composer.jong)
  );
}

function appendJamo(composer: Composer, jamo: string): void {
  if (isVowel(jamo)) {
    if (composer.cho && composer.jung && composer.jong) {
      const split =
        composer.jong.length === 2
          ? [composer.jong[0], composer.jong[1]]
          : [composer.jong];
      const moved = split.pop()!;
      composer.committed += compose(
        composer.cho,
        composer.jung,
        split.join(''),
      );
      composer.cho = moved;
      composer.jung = jamo;
      composer.jong = '';
    } else if (composer.cho && composer.jung) {
      const vowel = JUNG.find(
        (candidate) =>
          VOWEL_KEYS[candidate] ===
          VOWEL_KEYS[composer.jung] + VOWEL_KEYS[jamo],
      );
      if (vowel) composer.jung = vowel;
      else {
        composer.committed += render(composer).slice(composer.committed.length);
        composer.cho = '';
        composer.jung = '';
        composer.jong = '';
        appendJamo(composer, jamo);
      }
    } else if (composer.cho) composer.jung = jamo;
    else composer.committed += jamo;
    return;
  }
  if (!isConsonant(jamo)) {
    composer.committed +=
      render(composer).slice(composer.committed.length) + jamo;
    composer.cho = '';
    composer.jung = '';
    composer.jong = '';
    return;
  }
  if (composer.cho && composer.jung) {
    if (!composer.jong) composer.jong = jamo;
    else {
      const combined = FINAL_COMBINATIONS[composer.jong + jamo];
      if (combined) composer.jong = combined;
      else {
        composer.committed += compose(
          composer.cho,
          composer.jung,
          composer.jong,
        );
        composer.cho = jamo;
        composer.jung = '';
        composer.jong = '';
      }
    }
  } else if (composer.cho) {
    const combined = INITIAL_COMBINATIONS[composer.cho + jamo];
    if (combined) composer.cho = combined;
    else {
      composer.committed += composer.cho;
      composer.cho = jamo;
    }
  } else composer.cho = jamo;
}

/** Returns the visible text after every physical 2-set keystroke. */
export function createHangulTypingSnapshots(text: string): string[] {
  const normalized = text.normalize('NFC');
  const snapshots: string[] = [];
  const composer: Composer = { committed: '', cho: '', jung: '', jong: '' };
  for (const character of normalized) {
    const sequence = keySequenceFor(character);
    if (!sequence) {
      appendJamo(composer, character);
      snapshots.push(render(composer));
      continue;
    }
    for (const key of sequence) {
      const jamo = KEY_TO_JAMO.get(key);
      if (jamo) appendJamo(composer, jamo);
      else appendJamo(composer, key);
      snapshots.push(render(composer));
    }
  }
  return snapshots;
}

export function normalizeImeText(text: string): string {
  return text.normalize('NFC');
}
