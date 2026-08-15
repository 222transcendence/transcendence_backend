import { AppDataSource } from '../src/data-source';
import { ParticipantPerformance } from '../src/game/entities/participant-performance.entity';
import { TypeOrmPlayerPerformanceSource } from '../src/game/player-performance-source';
import type { Repository } from 'typeorm';

const enabled =
  process.env.AI_INTEGRATION === '1' && process.env.AI_PG_INTEGRATION === '1';
const describePostgres = enabled ? describe : describe.skip;

describePostgres('Player performance PostgreSQL integration', () => {
  const matchId = '11111111-1111-4111-8111-111111111110';
  const userId = '22222222-2222-4222-8222-222222222220';
  let repository: Repository<ParticipantPerformance>;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    repository = AppDataSource.getRepository(ParticipantPerformance);
  });

  beforeEach(async () => {
    await repository.delete({ matchId });
    await repository.save([
      repository.create({
        matchId,
        participantId: 'human-pvp',
        userId,
        participantType: 'HUMAN',
        mode: 'PVP',
        resultStatus: 'FINISHED',
        typingWpm: 55,
        effectiveWordsPerMinute: 30,
        accuracy: 0.9,
        avgReactionTimeMs: 600,
        createdAt: new Date('2026-08-14T00:00:01.000Z'),
      }),
      repository.create({
        matchId,
        participantId: 'human-ai-practice',
        userId,
        participantType: 'HUMAN',
        mode: 'AI_PRACTICE',
        resultStatus: 'FINISHED',
        typingWpm: 60,
        effectiveWordsPerMinute: 35,
        accuracy: 0.92,
        avgReactionTimeMs: 550,
        createdAt: new Date('2026-08-14T00:00:02.000Z'),
      }),
      repository.create({
        matchId,
        participantId: 'ai-practice-opponent',
        userId,
        participantType: 'AI',
        mode: 'AI_PRACTICE',
        resultStatus: 'FINISHED',
        typingWpm: 140,
        effectiveWordsPerMinute: 100,
        accuracy: 1,
        avgReactionTimeMs: 250,
        createdAt: new Date('2026-08-14T00:00:03.000Z'),
      }),
      repository.create({
        matchId,
        participantId: 'aborted-human',
        userId,
        participantType: 'HUMAN',
        mode: 'PVP',
        resultStatus: 'ABORTED',
        typingWpm: 100,
        effectiveWordsPerMinute: 70,
        accuracy: 1,
        avgReactionTimeMs: 250,
        createdAt: new Date('2026-08-14T00:00:04.000Z'),
      }),
      repository.create({
        matchId,
        participantId: 'invalid-human',
        userId,
        participantType: 'HUMAN',
        mode: 'PVP',
        resultStatus: 'FINISHED',
        typingWpm: null,
        accuracy: 0.9,
        avgReactionTimeMs: 600,
        createdAt: new Date('2026-08-14T00:00:05.000Z'),
      }),
    ]);
  });

  afterEach(async () => {
    await repository.delete({ matchId });
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  });

  it('returns finished HUMAN PVP and AI-practice samples while excluding AI and invalid rows', async () => {
    const source = new TypeOrmPlayerPerformanceSource(repository);
    await expect(source.getRecentPerformance(userId, 10)).resolves.toEqual([
      { wpm: 60, accuracy: 0.92, reactionTimeMs: 550 },
      { wpm: 55, accuracy: 0.9, reactionTimeMs: 600 },
    ]);
  });

  it('applies the requested sample limit after filtering valid rows', async () => {
    const source = new TypeOrmPlayerPerformanceSource(repository);
    await expect(source.getRecentPerformance(userId, 1)).resolves.toEqual([
      { wpm: 60, accuracy: 0.92, reactionTimeMs: 550 },
    ]);
  });
});
