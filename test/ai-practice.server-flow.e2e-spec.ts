import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AiPracticeService } from '../src/game/ai-practice.service';
import { AcidRainService } from '../src/game/acid-rain/acid-rain.service';
import { AiScheduler } from '../src/game/acid-rain/ai/ai-scheduler';
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
  let aiScheduler: AiScheduler;
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
    aiScheduler = app.get(AiScheduler);
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

    // Regression guard for #200: a new user has no performance rows, but the
    // population fallback must still finish preload and materialize the
    // execution profile before the AI room starts producing monitor state.
    // The first word-spawn notification occurs after the countdown; give the
    // scheduler one spawn cycle before inspecting its monitor snapshot.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const monitorSnapshot = aiScheduler.getLatestMonitorSnapshot(
      created.roomId,
    );
    expect(monitorSnapshot?.profile).toMatchObject({
      source: 'DEFAULT',
      sampleCount: 0,
      fallbackReason: 'NO_PERSONAL_SAMPLES',
    });
    const executionProfile = monitorSnapshot?.executionProfile;
    expect(executionProfile).toBeDefined();
    if (executionProfile) {
      expect(executionProfile.difficulty).toBe('NORMAL');
      expect(typeof executionProfile.typingWpm).toBe('number');
      expect(typeof executionProfile.effectiveWordsPerMinute).toBe('number');
    }

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

  it('measures reaction and typing on the real Acid Rain AI task lifecycle', async () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.99);
    let lifecycleRoomId: string | undefined;
    try {
      const created = await aiPracticeService.createAiPractice({
        ownerUserId: user.id,
        ownerNickname: user.nickname,
        ownerAvatar: user.avatar,
        requestId: `ai200-lifecycle-${fixtureSuffix}`,
        difficulty: 'NORMAL',
      });
      lifecycleRoomId = created.roomId;
      await acidRainService.startMatch(
        created.roomId,
        server,
        created.participants,
        'AI_PRACTICE',
      );
      await new Promise((resolve) => setTimeout(resolve, 3200));

      const session = acidRainService.getSession(created.roomId);
      expect(session?.status).toBe('IN_PROGRESS');
      if (!session) throw new Error('AI session was not created');
      const monitorStart = emit.mock.calls.length;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      session.spawnLoopTimer = null;
      session.activeWords.clear();

      const firstWord = {
        wordId: 'ai200-first-target',
        text: 'abc',
        keystrokes: 3,
        lane: 0,
        fallDurationMs: 6000,
        spawnedAt: new Date().toISOString(),
        landAt: Date.now() + 60_000,
        damage: 1,
      };
      session.activeWords.set(firstWord.wordId, firstWord);
      session.stateVersion += 1;
      const serviceWithNotify = acidRainService as unknown as {
        notifyAiStateChanged: (
          value: typeof session,
          currentServer: typeof server,
          event: 'SPAWN' | 'CLEAR' | 'MISS',
        ) => void;
      };
      const notifyAiStateChanged = (
        value: typeof session,
        currentServer: typeof server,
        event: 'SPAWN' | 'CLEAR' | 'MISS',
      ): void => {
        serviceWithNotify.notifyAiStateChanged.call(
          acidRainService,
          value,
          currentServer,
          event,
        );
      };
      notifyAiStateChanged(session, server, 'SPAWN');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const firstTask = aiScheduler.getTask(created.roomId);
      expect(firstTask).toBeDefined();
      if (!firstTask) throw new Error('AI did not acquire the first target');
      expect(firstTask.wordId).toBe(firstWord.wordId);
      const firstReactionMs =
        firstTask.reactionEndsAtMs - firstTask.selectedAtMs;
      const firstTypingMs =
        Math.max(...firstTask.timeline.map((segment) => segment.completionMs)) -
        firstTask.typingStartedAtMs;

      const secondWord = {
        ...firstWord,
        wordId: 'ai200-switch-target',
        damage: 100,
      };
      session.activeWords.set(secondWord.wordId, secondWord);
      session.stateVersion += 1;
      notifyAiStateChanged(session, server, 'SPAWN');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const secondTask = aiScheduler.getTask(created.roomId);
      expect(secondTask?.wordId).toBe(secondWord.wordId);
      expect(secondTask?.selectedAtMs).toBeGreaterThanOrEqual(
        firstTask.selectedAtMs,
      );
      expect(secondTask?.reactionEndsAtMs).toBeGreaterThan(
        secondTask?.selectedAtMs ?? 0,
      );
      const switchReactionMs =
        (secondTask?.reactionEndsAtMs ?? 0) - (secondTask?.selectedAtMs ?? 0);
      expect(switchReactionMs).toBeLessThan(100);

      const monitorEvents = emit.mock.calls
        .slice(monitorStart)
        .filter(
          ([event, payload]) =>
            event === 'ai_monitor_snapshot' &&
            (payload as { roomId?: string }).roomId === created.roomId,
        )
        .map(([, payload]) => payload as Record<string, unknown>);
      const switchCount = monitorEvents.filter(
        (payload) =>
          (payload.currentDecision as { action?: string } | undefined)
            ?.action === 'SWITCH' &&
          (payload.currentDecision as { targetWordId?: string } | undefined)
            ?.targetWordId === secondWord.wordId,
      ).length;
      expect(switchCount).toBeGreaterThanOrEqual(1);

      await new Promise((resolve) => setTimeout(resolve, 3200));
      const ai = session.participants.find(
        (participant) => participant.type === 'AI',
      );
      expect(ai?.wordsTyped).toBeGreaterThanOrEqual(1);

      await acidRainService.endMatch(created.roomId, 'FORFEIT', server);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const performance = await dataSource
        .getRepository(ParticipantPerformance)
        .findOneByOrFail({
          matchId: created.roomId,
          participantType: 'AI',
        });
      expect(performance.correctWords).toBeGreaterThanOrEqual(1);
      expect(performance.totalKeystrokes).toBeGreaterThanOrEqual(3);
      expect(performance.typingWpm).toBeGreaterThan(0);
      expect(performance.effectiveWordsPerMinute).toBeGreaterThan(0);
      expect(firstReactionMs).toBeGreaterThan(0);
      expect(firstTypingMs).toBeGreaterThan(0);
      expect(performance.effectiveWordsPerMinute).toBeLessThan(
        performance.typingWpm!,
      );
    } finally {
      if (lifecycleRoomId && acidRainService.getSession(lifecycleRoomId)) {
        try {
          await acidRainService.endMatch(lifecycleRoomId, 'FORFEIT', server);
        } catch {
          // The assertion failure is the primary test signal; cleanup is best effort.
        }
      }
      randomSpy.mockRestore();
    }
  });
});
