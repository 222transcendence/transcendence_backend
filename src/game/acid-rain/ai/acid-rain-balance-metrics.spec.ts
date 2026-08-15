import { DEFAULT_PLAYER_SKILL } from '../../player-model';
import {
  createEvaluatorProfile,
  DefaultAiExecutionProfileFactory,
} from './ai-execution-profile';
import { AiExecutor } from './ai-executor';
import type { Clock, RandomSource } from './ai-execution.types';

/**
 * deploy#79 밸런스 플레이테스트 — "실제 플레이로만 확인 가능한" 부분(손맛, 실시간
 * 여러 탭 조작)은 자동화할 수 없어 팀 수동 플레이테스트로 넘긴다(Documents/
 * Issue79_AcidRain_Balance_Playtest_Report.md 참고). 이 파일은 그 문서가 요구하는
 * "사전 측정 기준"·"검증 시나리오" 중 결정론적으로 재현 가능한 부분(길이 구간별
 * 위험/보상, 스폰 압박)을 시드 기반 시뮬레이션으로 측정해 회귀 가드 + 수치 근거로
 * 남긴다.
 */

type Difficulty = 'BEGINNER' | 'NORMAL' | 'HARD';
const DIFFICULTIES: readonly Difficulty[] = ['BEGINNER', 'NORMAL', 'HARD'];
const SEEDS = [
  ...Array.from({ length: 24 }, (_, index) => index + 1),
  ...Array.from({ length: 24 }, (_, index) => index + 2023),
];

// GAME_DESIGN.md §3.6 "대표 비교" 표의 구간별 대표 타수를 그대로 재사용한다.
const BUCKETS = [
  { name: 'LOW', keystrokes: 4 },
  { name: 'MID', keystrokes: 8 },
  { name: 'HIGH', keystrokes: 12 },
  { name: 'HIGH_TOP', keystrokes: 16 },
] as const;

// 매치 초반/중반/후반 압박 차이를 보기 위한 경과 시각 체크포인트.
const ELAPSED_CHECKPOINTS = [10, 60, 120, 170] as const;

// acid-rain.service.ts damageForKeystrokes / §3.6 데미지 공식과 동일.
function damageForKeystrokes(keystrokes: number): number {
  return 5 + Math.ceil(keystrokes / 2);
}

// acid-rain.service.ts startSpawnLoop / §3.5 낙하 시간 공식과 동일.
function fallDurationMs(keystrokes: number, elapsedSec: number): number {
  return Math.round(
    (4000 + 250 * keystrokes) * Math.max(0.6, 1 - elapsedSec / 300),
  );
}

// acid-rain.service.ts scheduleNext / §3.3 스폰 간격 공식과 동일.
function spawnIntervalMs(elapsedSec: number): number {
  return Math.max(400, 1000 - 50 * Math.floor(elapsedSec / 10));
}

// acid-rain.service.ts spawnCountForElapsed / §3.3a 틱당 스폰 개수 공식과 동일.
function spawnCountForElapsed(elapsedSec: number): number {
  return Math.min(4, 2 + Math.floor(elapsedSec / 30));
}

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next: () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

interface BucketRunResult {
  success: boolean;
  latencyMs: number;
  fallDurationMs: number;
  damage: number;
}

function runBucketOnce(
  difficulty: Difficulty,
  keystrokes: number,
  elapsedSec: number,
  seed: number,
): BucketRunResult {
  let now = 0;
  const clock: Clock = { now: () => now };
  const random = seededRandom(seed);
  const executor = new AiExecutor(clock, random);
  const factory = new DefaultAiExecutionProfileFactory();
  const execution = factory.create(DEFAULT_PLAYER_SKILL, difficulty);
  const evaluator = createEvaluatorProfile(execution, difficulty);
  const landAtMs = fallDurationMs(keystrokes, elapsedSec);
  const word = {
    wordId: 'balance-word',
    text: 'x'.repeat(keystrokes),
    keystrokes,
    landAtMs,
    damage: damageForKeystrokes(keystrokes),
  };
  const abandoned = executor.shouldAbandon(evaluator);
  const task = executor.createTask(
    'balance-room',
    word,
    evaluator,
    1,
    `seed-${seed}`,
  );
  now = executor.completionMs(task);
  const success = !abandoned && now <= landAtMs;

  return { success, latencyMs: now, fallDurationMs: landAtMs, damage: word.damage };
}

interface BucketAggregate {
  bucket: string;
  keystrokes: number;
  elapsedSec: number;
  difficulty: Difficulty;
  successRate: number;
  missRate: number;
  avgFallDurationMs: number;
  damage: number;
  expectedDamage: number; // successRate * damage — "선점 성공 시 기대 보상"
}

function aggregateBucket(
  bucket: (typeof BUCKETS)[number],
  elapsedSec: number,
  difficulty: Difficulty,
): BucketAggregate {
  const results = SEEDS.map((seed) =>
    runBucketOnce(difficulty, bucket.keystrokes, elapsedSec, seed),
  );
  const successRate =
    results.filter((r) => r.success).length / results.length;

  return {
    bucket: bucket.name,
    keystrokes: bucket.keystrokes,
    elapsedSec,
    difficulty,
    successRate,
    missRate: 1 - successRate,
    avgFallDurationMs: results[0].fallDurationMs,
    damage: results[0].damage,
    expectedDamage: successRate * results[0].damage,
  };
}

describe('Acid Rain balance metrics — 길이 구간별 위험/보상 (deploy#79)', () => {
  const table: BucketAggregate[] = [];
  beforeAll(() => {
    for (const difficulty of DIFFICULTIES) {
      for (const elapsedSec of ELAPSED_CHECKPOINTS) {
        for (const bucket of BUCKETS) {
          table.push(aggregateBucket(bucket, elapsedSec, difficulty));
        }
      }
    }
  });

  it('replays the same bucket/difficulty/elapsed/seed trace exactly (재현성)', () => {
    const a = runBucketOnce('NORMAL', 8, 60, 42);
    const b = runBucketOnce('NORMAL', 8, 60, 42);
    expect(a).toEqual(b);
  });

  it('데미지는 구간 길이에 비례해 단조 증가한다 (damageForKeystrokes)', () => {
    for (const bucket of BUCKETS) {
      expect(damageForKeystrokes(bucket.keystrokes)).toBe(
        5 + Math.ceil(bucket.keystrokes / 2),
      );
    }
    const damages = BUCKETS.map((b) => damageForKeystrokes(b.keystrokes));
    for (let i = 1; i < damages.length; i++) {
      expect(damages[i]).toBeGreaterThan(damages[i - 1]);
    }
  });

  it('가장 긴 구간(HIGH_TOP)도 항상 성공하지는 않는다 — 긴 단어 추가시간이 입력부담을 완전히 상쇄하지 않음', () => {
    const highTopRows = table.filter((row) => row.bucket === 'HIGH_TOP');
    expect(highTopRows.some((row) => row.successRate < 1)).toBe(true);
  });

  it('가장 짧은 구간(LOW)은 모든 난이도/시점에서 실제로 선점 가능하다 — 위험 낮은 선택지가 항상 막혀있지 않음', () => {
    const lowRows = table.filter((row) => row.bucket === 'LOW');
    expect(lowRows.every((row) => row.successRate > 0)).toBe(true);
  });

  it('짧은 단어 전략과 긴 단어 전략의 기대 데미지가 한쪽으로 극단적으로 쏠리지 않는다 (NORMAL, 60s 기준)', () => {
    const rows = table.filter(
      (row) => row.difficulty === 'NORMAL' && row.elapsedSec === 60,
    );
    const expectedDamages = rows.map((row) => row.expectedDamage);
    const max = Math.max(...expectedDamages);
    const min = Math.min(...expectedDamages);
    // 완전히 동일할 필요는 없지만, 한 구간이 다른 구간을 3배 이상 압도하면
    // "특정 길이만 선택하는 전략이 일방적으로 우세"할 가능성이 높다고 본다.
    expect(max / min).toBeLessThan(3);
  });

  it('밸런스 표 요약 (Documents 보고서용 — 콘솔 출력)', () => {
    // eslint-disable-next-line no-console
    console.table(
      table.map((row) => ({
        difficulty: row.difficulty,
        elapsedSec: row.elapsedSec,
        bucket: row.bucket,
        keystrokes: row.keystrokes,
        fallDurationMs: row.avgFallDurationMs,
        damage: row.damage,
        successRate: row.successRate.toFixed(2),
        missRate: row.missRate.toFixed(2),
        expectedDamage: row.expectedDamage.toFixed(2),
      })),
    );
    expect(table.length).toBe(
      DIFFICULTIES.length * ELAPSED_CHECKPOINTS.length * BUCKETS.length,
    );
  });
});

describe('Acid Rain balance metrics — 스폰 압박 근사치 (deploy#79)', () => {
  // 참가자 수별 maxActiveWords = 5 * participants (acid-rain.service.ts WORDS_PER_PLAYER).
  const PARTICIPANT_COUNTS = [2, 3, 4] as const;
  const WORDS_PER_PLAYER = 5;

  // §3.4 구간 가중치(40초 이후 LOW/MID/HIGH = 25/35/40)로 가중 평균한 대표 타수.
  function weightedAvgKeystrokes(elapsedSec: number): number {
    if (elapsedSec < 10) return 4; // LOW만
    if (elapsedSec < 40) return (4 + 8) / 2; // LOW+MID 균등
    return 0.25 * 4 + 0.35 * 8 + 0.4 * 12; // LOW/MID/HIGH = 25/35/40
  }

  interface PressureRow {
    participants: number;
    elapsedSec: number;
    maxActiveWords: number;
    steadyStateEstimate: number;
    pressureRatio: number; // steadyStateEstimate / maxActiveWords
  }

  const rows: PressureRow[] = [];
  beforeAll(() => {
    for (const participants of PARTICIPANT_COUNTS) {
      const maxActiveWords = WORDS_PER_PLAYER * participants;
      for (const elapsedSec of ELAPSED_CHECKPOINTS) {
        const interval = spawnIntervalMs(elapsedSec);
        const perTick = spawnCountForElapsed(elapsedSec);
        const spawnRatePerSec = (perTick * 1000) / interval;
        const avgFall = fallDurationMs(
          weightedAvgKeystrokes(elapsedSec),
          elapsedSec,
        );
        // 정상상태 근사: 도착률(spawnRate) * 평균 체류시간(avgFall) — 스폰 skip을
        // 반영하지 않은 "cap이 없을 때 활성 단어가 얼마나 쌓일지"에 대한 상한 추정치.
        const steadyStateEstimate = spawnRatePerSec * (avgFall / 1000);
        rows.push({
          participants,
          elapsedSec,
          maxActiveWords,
          steadyStateEstimate,
          pressureRatio: steadyStateEstimate / maxActiveWords,
        });
      }
    }
  });

  it('참가자 수가 늘수록 동일 시점의 캡(maxActiveWords)도 비례해서 늘어난다', () => {
    const at60s = rows.filter((r) => r.elapsedSec === 60);
    expect(at60s[1].maxActiveWords).toBeGreaterThan(at60s[0].maxActiveWords);
    expect(at60s[2].maxActiveWords).toBeGreaterThan(at60s[1].maxActiveWords);
  });

  it('매치 후반(170s)에는 정상상태 추정치가 캡을 초과해 스폰 skip이 실제로 발생할 조건이 된다', () => {
    const late = rows.filter((r) => r.elapsedSec === 170);
    expect(late.every((r) => r.pressureRatio >= 1)).toBe(true);
  });

  it('경과 시간이 늘수록 스폰 압박은 참가자 수와 무관하게 단조 비증가하지 않는 경우가 없다 (압박은 시간에 따라 커지거나 유지된다)', () => {
    for (const participants of PARTICIPANT_COUNTS) {
      const series = ELAPSED_CHECKPOINTS.map(
        (elapsedSec) =>
          rows.find(
            (r) => r.participants === participants && r.elapsedSec === elapsedSec,
          )!.pressureRatio,
      );
      for (let i = 1; i < series.length; i++) {
        expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]);
      }
    }
  });

  it('2인전은 매치 초반(10s)부터 이미 캡 근처거나 초과한다 — 참가자가 적을수록 압박 체감이 빠르다', () => {
    const twoPlayerEarly = rows.find(
      (r) => r.participants === 2 && r.elapsedSec === 10,
    )!;
    const fourPlayerEarly = rows.find(
      (r) => r.participants === 4 && r.elapsedSec === 10,
    )!;
    expect(twoPlayerEarly.pressureRatio).toBeGreaterThan(
      fourPlayerEarly.pressureRatio,
    );
  });

  it('스폰 압박 요약표 (Documents 보고서용 — 콘솔 출력)', () => {
    // eslint-disable-next-line no-console
    console.table(
      rows.map((r) => ({
        participants: r.participants,
        elapsedSec: r.elapsedSec,
        maxActiveWords: r.maxActiveWords,
        steadyStateEstimate: r.steadyStateEstimate.toFixed(1),
        pressureRatio: r.pressureRatio.toFixed(2),
      })),
    );
    expect(rows.length).toBe(
      PARTICIPANT_COUNTS.length * ELAPSED_CHECKPOINTS.length,
    );
  });
});
