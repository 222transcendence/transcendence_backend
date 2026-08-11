import { WORD_BANK, WordEntry } from './word-bank';

/**
 * 난이도 구간(GAME_DESIGN.md §3.2). 현재 단어 은행(400개) 분포 기준으로
 * 각 구간이 고르게 나뉘도록 정한 경계값.
 */
const LOW_MAX_KEYSTROKES = 5;
const MID_MAX_KEYSTROKES = 9;

const LOW_POOL = WORD_BANK.filter((w) => w.keystrokes <= LOW_MAX_KEYSTROKES);
const MID_POOL = WORD_BANK.filter(
  (w) =>
    w.keystrokes > LOW_MAX_KEYSTROKES && w.keystrokes <= MID_MAX_KEYSTROKES,
);
const HIGH_POOL = WORD_BANK.filter((w) => w.keystrokes > MID_MAX_KEYSTROKES);
// 30~90초 구간에서 LOW/MID를 합쳐 균등 추출하기 위한 캐시(§3.4 "매 스폰마다 필터링하지 않도록" 권고 반영)
const LOW_MID_POOL = [...LOW_POOL, ...MID_POOL];

function randomFrom(pool: readonly WordEntry[]): WordEntry {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 경과 시간별 난이도 구간 가중치(GAME_DESIGN.md §3.4).
 * - 0~30초: LOW만
 * - 30~90초: LOW+MID 단어 풀 전체에서 균등 추출 (구간별 가중치는 문서에 명시되지 않음 —
 *   90초 이후처럼 구간 단위 가중치를 별도로 두지 않고, 두 구간을 하나의 풀로 합쳐 뽑는 것으로 해석)
 * - 90초~: LOW/MID/HIGH = 40/35/25 가중치
 */
export function pickWord(elapsedSec: number): WordEntry {
  if (elapsedSec < 30) return randomFrom(LOW_POOL);
  if (elapsedSec < 90) return randomFrom(LOW_MID_POOL);

  const roll = Math.random();
  if (roll < 0.4) return randomFrom(LOW_POOL);
  if (roll < 0.75) return randomFrom(MID_POOL);
  return randomFrom(HIGH_POOL);
}

export const __testing = { LOW_POOL, MID_POOL, HIGH_POOL, LOW_MID_POOL };
