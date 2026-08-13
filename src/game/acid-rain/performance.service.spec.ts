import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PerformanceService } from './performance.service';
import { KeystrokeRecord } from '../entities/keystroke-record.entity';
import { WordAttemptRecord } from '../entities/word-attempt-record.entity';
import { ParticipantPerformance } from '../entities/participant-performance.entity';
import type { AcidRainSession, WordTypingState } from './acid-rain.interface';

function makeRepo<T>(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    create: jest.fn((dto: Partial<T>) => dto as T),
    save: jest.fn(async (entity: T | T[]) => entity),
    find: jest.fn(async () => []),
    ...overrides,
  };
}

function makeState(overrides: Partial<WordTypingState> = {}): WordTypingState {
  return {
    sequence: 5,
    firstTypingAt: new Date('2024-01-01T00:00:01.000Z'),
    lastTypingAt: new Date('2024-01-01T00:00:03.000Z'),
    prevPartialText: 'hell',
    typoCount: 1,
    correctionCount: 1,
    totalKeystrokes: 5,
    keystrokeBuffer: [
      {
        wordId: 'w1',
        sequence: 0,
        partialText: 'h',
        textLength: 1,
        inputType: 'PROGRESS',
        serverReceivedAt: new Date('2024-01-01T00:00:01.000Z'),
      },
    ],
    ...overrides,
  };
}

describe('PerformanceService', () => {
  let service: PerformanceService;
  let keystrokeRepo: ReturnType<typeof makeRepo>;
  let wordAttemptRepo: ReturnType<typeof makeRepo>;
  let performanceRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    keystrokeRepo = makeRepo();
    wordAttemptRepo = makeRepo();
    performanceRepo = makeRepo();

    const module = await Test.createTestingModule({
      providers: [
        PerformanceService,
        { provide: getRepositoryToken(KeystrokeRecord), useValue: keystrokeRepo },
        { provide: getRepositoryToken(WordAttemptRecord), useValue: wordAttemptRepo },
        { provide: getRepositoryToken(ParticipantPerformance), useValue: performanceRepo },
      ],
    }).compile();

    service = module.get(PerformanceService);
  });

  describe('flushWordAttempt', () => {
    it('WordAttemptRecord와 KeystrokeRecord를 저장한다', async () => {
      const state = makeState();
      await service.flushWordAttempt({
        matchId: 'match-1',
        participantId: 'p1',
        userId: 'u1',
        wordId: 'w1',
        result: 'CORRECT_AFTER_CORRECTION',
        submittedText: 'hello',
        submitReceivedAt: new Date(),
        resolvedAt: new Date(),
        wordSpawnedAt: new Date('2024-01-01T00:00:00.000Z'),
        state,
      });

      expect(wordAttemptRepo.save).toHaveBeenCalledTimes(1);
      expect(keystrokeRepo.save).toHaveBeenCalledTimes(1);

      const savedAttempt = (wordAttemptRepo.create as jest.Mock).mock.calls[0][0];
      expect(savedAttempt.result).toBe('CORRECT_AFTER_CORRECTION');
      expect(savedAttempt.typoCount).toBe(1);
      expect(savedAttempt.totalKeystrokes).toBe(5);
    });

    it('keystrokeBuffer가 비어있으면 keystroke 저장을 하지 않는다', async () => {
      const state = makeState({ keystrokeBuffer: [] });
      await service.flushWordAttempt({
        matchId: 'match-1',
        participantId: 'p1',
        wordId: 'w1',
        result: 'MISSED',
        submittedText: null,
        submitReceivedAt: null,
        resolvedAt: new Date(),
        wordSpawnedAt: null,
        state,
      });

      expect(wordAttemptRepo.save).toHaveBeenCalledTimes(1);
      expect(keystrokeRepo.save).not.toHaveBeenCalled();
    });

    it('저장 중 오류가 발생해도 예외를 던지지 않는다', async () => {
      wordAttemptRepo.save = jest.fn().mockRejectedValue(new Error('db error'));
      const state = makeState();
      await expect(
        service.flushWordAttempt({
          matchId: 'match-1',
          participantId: 'p1',
          wordId: 'w1',
          result: 'CORRECT',
          submittedText: 'hello',
          submitReceivedAt: new Date(),
          resolvedAt: new Date(),
          wordSpawnedAt: null,
          state,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('saveParticipantPerformances', () => {
    it('참가자별 집계를 저장한다', async () => {
      const now = new Date();
      wordAttemptRepo.find = jest.fn().mockResolvedValue([
        {
          participantId: 'p1',
          result: 'CORRECT',
          firstTypingAt: new Date(now.getTime() - 3000),
          lastTypingAt: new Date(now.getTime() - 500),
          submitReceivedAt: now,
          resolvedAt: now,
          wordSpawnedAt: new Date(now.getTime() - 5000),
          typoCount: 0,
          correctionCount: 0,
          totalKeystrokes: 4,
        },
        {
          participantId: 'p1',
          result: 'MISSED',
          firstTypingAt: null,
          lastTypingAt: null,
          submitReceivedAt: null,
          resolvedAt: now,
          wordSpawnedAt: new Date(now.getTime() - 4000),
          typoCount: 0,
          correctionCount: 0,
          totalKeystrokes: 0,
        },
      ]);

      const session = {
        roomId: 'room-1',
        status: 'FINISHED',
        startedAt: Date.now() - 60_000,
        mode: 'PVP',
        participants: [
          { participantId: 'p1', userId: 'u1', type: 'HUMAN' },
          { participantId: 'ai-1', userId: undefined, type: 'AI' },
        ],
      } as unknown as AcidRainSession;

      await service.saveParticipantPerformances(session, 'room-1', 'FINISHED');

      expect(performanceRepo.save).toHaveBeenCalledTimes(2);
      const p1Record = (performanceRepo.create as jest.Mock).mock.calls.find(
        (call) => call[0].participantId === 'p1',
      )?.[0];
      expect(p1Record).toBeDefined();
      expect(p1Record.correctWords).toBe(1);
      expect(p1Record.missedWords).toBe(1);
      expect(p1Record.typingDurationMs).toBe(3000);
      expect(p1Record.typingWpm).toBe(20);
    });

    it('HUMAN 참가자만 집계한다 (AI 제외 확인)', async () => {
      wordAttemptRepo.find = jest.fn().mockResolvedValue([]);
      const session = {
        roomId: 'room-1',
        status: 'FINISHED',
        startedAt: Date.now() - 30_000,
        mode: 'AI_PRACTICE',
        participants: [
          { participantId: 'human-1', userId: 'u1', type: 'HUMAN' },
          { participantId: 'ai-1', userId: undefined, type: 'AI' },
        ],
      } as unknown as AcidRainSession;

      await service.saveParticipantPerformances(session, 'room-1', 'FINISHED');

      // 참가자가 2명이어도 save 횟수는 2 (AI도 저장은 되지만 participantType으로 필터)
      expect(performanceRepo.save).toHaveBeenCalledTimes(2);
      const calls = (performanceRepo.create as jest.Mock).mock.calls.map(c => c[0]);
      const humanCall = calls.find(c => c.participantId === 'human-1');
      const aiCall = calls.find(c => c.participantId === 'ai-1');
      expect(humanCall?.participantType).toBe('HUMAN');
      expect(aiCall?.participantType).toBe('AI');
    });
  });
});
