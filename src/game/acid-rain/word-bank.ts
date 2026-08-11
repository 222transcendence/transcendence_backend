import { WordTier } from './acid-rain.interface';

// 큐레이션 단어 목록은 이슈 #73에서 300~500개로 교체 예정.
// 현재는 동작 검증용 샘플 60개.
const WORD_BANK: Record<WordTier, string[]> = {
  easy: [
    '가방', '나무', '바람', '하늘', '사랑', '강물', '눈물', '달빛',
    '봄날', '여름', '가을', '겨울', '노래', '마음', '별빛', '소리',
    '아침', '저녁', '파도', '꿈길',
  ],
  medium: [
    '산성비', '타자기', '컴퓨터', '프로그램', '인터넷', '스마트폰',
    '자동차', '비행기', '우주선', '도서관', '음악회', '영화관',
    '해바라기', '무지개빛', '초록숲', '바닷가', '코드리뷰', '데이터',
    '알고리즘', '네트워크',
  ],
  hard: [
    '프로그래밍', '알고리즘학습', '데이터베이스', '클라우드서버',
    '오픈소스프로젝트', '인공지능모델', '머신러닝기술', '소프트웨어개발',
    '웹소켓통신', '실시간게임서버', '도커컨테이너', '마이크로서비스',
    '비동기프로그래밍', '타입스크립트', '네스트제이에스',
    '리액트프레임워크', '리덕스상태관리', '그래프큐엘', '레스트에이피아이',
    '분산시스템설계',
  ],
};

export interface WordEntry {
  text: string;
  tier: WordTier;
}

const ALL_WORDS: WordEntry[] = (Object.entries(WORD_BANK) as [WordTier, string[]][]).flatMap(
  ([tier, words]) => words.map((text) => ({ text, tier })),
);

const TIER_WEIGHTS: Record<WordTier, number> = { easy: 1, medium: 0, hard: 0 };

function weightedPick(elapsedSec: number): WordEntry {
  if (elapsedSec < 30) {
    TIER_WEIGHTS.easy = 1; TIER_WEIGHTS.medium = 0; TIER_WEIGHTS.hard = 0;
  } else if (elapsedSec < 90) {
    TIER_WEIGHTS.easy = 0.6; TIER_WEIGHTS.medium = 0.4; TIER_WEIGHTS.hard = 0;
  } else {
    TIER_WEIGHTS.easy = 0.4; TIER_WEIGHTS.medium = 0.35; TIER_WEIGHTS.hard = 0.25;
  }

  const rand = Math.random();
  let tier: WordTier;
  if (rand < TIER_WEIGHTS.easy) tier = 'easy';
  else if (rand < TIER_WEIGHTS.easy + TIER_WEIGHTS.medium) tier = 'medium';
  else tier = 'hard';

  const pool = WORD_BANK[tier];
  return { text: pool[Math.floor(Math.random() * pool.length)], tier };
}

export function pickWord(elapsedSec: number): WordEntry {
  return weightedPick(elapsedSec);
}

export { ALL_WORDS };
