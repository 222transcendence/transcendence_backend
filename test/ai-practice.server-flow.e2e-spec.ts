import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AiPracticeService } from '../src/game/ai-practice.service';
import { AcidRainService } from '../src/game/acid-rain/acid-rain.service';
import { GameService } from '../src/game/game.service';
import {
  MatchMode,
  MatchHistory,
} from '../src/game/entities/match-history.entity';
import { ParticipantPerformance } from '../src/game/entities/participant-performance.entity';
import { User, UserStatus } from '../src/user/entities/user.entity';
import { DataSource } from 'typeorm';
import type { Server } from 'socket.io';

const enabled =
  process.env.AI_INTEGRATION === '1' &&
  process.env.AI_SERVER_FLOW_INTEGRATION === '1';
const describeFlow = enabled ? describe : describe.skip;

describeFlow('AI practice server-side flow integration', () => {
  jest.setTimeout(30_000);
  let app: INestApplication;
  let dataSource: DataSource;
  let user: User;
  let leaderboardPeer: User;
  let aiPracticeService: AiPracticeService;
  let acidRainService: AcidRainService;
  let gameService: GameService;
  const fixtureSuffix = `${Date.now()}-${process.pid}`;
  const emit = jest.fn();
  const serverTo = jest.fn().mockReturnValue({ emit });
  const server = {
    to: serverTo,
  } as unknown as Server;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    aiPracticeService = app.get(AiPracticeService);
    acidRainService = app.get(AcidRainService);
    gameService = app.get(GameService);

    const userRepository = dataSource.getRepository(User);
    [user, leaderboardPeer] = await userRepository.save([
      userRepository.create({
        email: `ai110-server-flow-${fixtureSuffix}@example.test`,
        nickname: `AI110 Server Flow ${fixtureSuffix}`,
        status: UserStatus.OFFLINE,
        wins: 40,
        losses: 1,
        draws: 0,
      }),
      userRepository.create({
        email: `ai110-leaderboard-peer-${fixtureSuffix}@example.test`,
        nickname: `AI110 Leaderboard Peer ${fixtureSuffix}`,
        status: UserStatus.OFFLINE,
        wins: 10,
        losses: 2,
        draws: 0,
      }),
    ]);
  });

  beforeEach(() => {
    emit.mockClear();
    serverTo.mockClear();
  });

  afterEach(async () => {
    const active = await aiPracticeService.getActiveAiPracticeForUser(user.id);
    if (active)
      await aiPracticeService.cancelAiPractice(user.id, active.roomId);
  });

  afterAll(async () => {
    await dataSource.getRepository(User).delete([user.id, leaderboardPeer.id]);
    await app.close();
  });

  it('runs create → start → AI submit → match end → save and keeps PvP stats and leaderboard unchanged', async () => {
    const userRepository = dataSource.getRepository(User);
    await userRepository.update(user.id, { wins: 40, losses: 1, draws: 0 });
    await userRepository.update(leaderboardPeer.id, {
      wins: 10,
      losses: 2,
      draws: 0,
    });
    const leaderboardBefore = await gameService.getLeaderboard();
    const userStatsBefore = await gameService.getUserStats(user.id);
    const userIndexBefore = leaderboardBefore.findIndex(
      (entry) => entry.id === user.id,
    );
    const peerIndexBefore = leaderboardBefore.findIndex(
      (entry) => entry.id === leaderboardPeer.id,
    );
    expect(userIndexBefore).toBeGreaterThanOrEqual(0);
    expect(peerIndexBefore).toBeGreaterThan(userIndexBefore);
    const historyRepository = dataSource.getRepository(MatchHistory);
    const existingHistoryIds = new Set(
      (
        await historyRepository.find({ where: { mode: MatchMode.AI_PRACTICE } })
      ).map((record) => record.id),
    );
    const created = await aiPracticeService.createAiPractice({
      ownerUserId: user.id,
      ownerNickname: user.nickname,
      ownerAvatar: user.avatar,
      requestId: 'ai110-server-flow-001',
      difficulty: 'NORMAL',
    });

    expect(created.participants).toHaveLength(2);
    await acidRainService.startMatch(
      created.roomId,
      server,
      created.participants,
      'AI_PRACTICE',
    );
    await new Promise((resolve) => setTimeout(resolve, 3200));

    const session = acidRainService.getSession(created.roomId);
    expect(session?.status).toBe('IN_PROGRESS');
    expect(session?.maxActiveWords).toBe(10);
    session?.activeWords.set('ai110-flow-word', {
      wordId: 'ai110-flow-word',
      text: 'abcdefgh',
      keystrokes: 8,
      lane: 0,
      fallDurationMs: 6000,
      spawnedAt: new Date(0).toISOString(),
      landAt: Date.now() + 60_000,
      damage: 9,
    });

    const ai = created.participants.find(
      (participant) => participant.type === 'AI',
    );
    expect(ai).toBeDefined();
    const submitResult = await acidRainService.submitWord(
      {
        roomId: created.roomId,
        playerId: ai!.participantId,
        wordId: 'ai110-flow-word',
        text: 'abcdefgh',
        attemptId: 'ai110-flow-attempt-001',
      },
      server,
    );
    expect(submitResult.accepted).toBe(true);

    await acidRainService.endMatch(created.roomId, 'FORFEIT', server);
    const history = (
      await historyRepository.find({
        where: { mode: MatchMode.AI_PRACTICE },
        order: { createdAt: 'DESC' },
      })
    ).find((record) => !existingHistoryIds.has(record.id));
    expect(history).not.toBeNull();

    const performances = await dataSource
      .getRepository(ParticipantPerformance)
      .find({ where: { matchId: created.roomId } });
    expect(performances).toHaveLength(2);
    expect(performances.map((record) => record.participantType).sort()).toEqual(
      ['AI', 'HUMAN'],
    );

    const leaderboardAfterPractice = await gameService.getLeaderboard();
    const freshUserRepository = dataSource
      .createEntityManager()
      .getRepository(User);
    const userAfterFromFreshRepository =
      await freshUserRepository.findOneByOrFail({
        id: user.id,
      });
    const freshTotalGames =
      userAfterFromFreshRepository.wins +
      userAfterFromFreshRepository.losses +
      userAfterFromFreshRepository.draws;
    expect({
      wins: userAfterFromFreshRepository.wins,
      losses: userAfterFromFreshRepository.losses,
      draws: userAfterFromFreshRepository.draws,
      totalGames: freshTotalGames,
      winRate:
        freshTotalGames > 0
          ? Math.round(
              (userAfterFromFreshRepository.wins / freshTotalGames) * 100,
            ) / 100
          : 0,
    }).toEqual(userStatsBefore);
    expect(leaderboardAfterPractice).toEqual(leaderboardBefore);
    expect(
      leaderboardAfterPractice.some((entry) => entry.id === ai!.participantId),
    ).toBe(false);

    await freshUserRepository.update(leaderboardPeer.id, {
      wins: 100,
      losses: 0,
      draws: 0,
    });
    const leaderboardAfterPvpPositiveControl =
      await gameService.getLeaderboard();
    expect(leaderboardAfterPvpPositiveControl).not.toEqual(
      leaderboardAfterPractice,
    );
    expect(
      leaderboardAfterPvpPositiveControl.findIndex(
        (entry) => entry.id === leaderboardPeer.id,
      ),
    ).toBeLessThan(
      leaderboardAfterPvpPositiveControl.findIndex(
        (entry) => entry.id === user.id,
      ),
    );
    expect(acidRainService.getSession(created.roomId)).toBeUndefined();
  });
});
