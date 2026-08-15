import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { GameService } from '../src/game/game.service';
import { AiPracticeService } from '../src/game/ai-practice.service';
import { AcidRainService } from '../src/game/acid-rain/acid-rain.service';
import { AcidRainGateway } from '../src/game/acid-rain/acid-rain.gateway';
import { User, UserStatus } from '../src/user/entities/user.entity';
import {
  MatchMode,
  MatchHistory,
} from '../src/game/entities/match-history.entity';
import type {
  MatchReadyEventPayload,
  StateSyncEventPayload,
  WordClearedEventPayload,
  WordMissedEventPayload,
  SubmitRejectedEventPayload,
  MatchEndEventPayload,
  ActiveWord,
} from '../src/game/acid-rain/acid-rain.interface';

// 이 스펙은 frontend#44([FE] 백엔드 연동 E2E 검증 — 실제 대전 플로우) 체크리스트를
// "실제 socket.io-client"로 검증한다. 기존 test/*.e2e-spec.ts는 전부 서비스 메서드를
// 인메모리로 직접 호출하는 방식이라 소켓 왕복(재접속 state_sync, 동시 제출 경합 등)이
// 한 번도 검증되지 않았다 — 그 공백을 메우는 것이 이 파일의 목적이다.
//
// 실행: docker-compose up -d db redis 로 의존 서비스를 띄운 뒤
//   E2E_SOCKET_INTEGRATION=1 npm run test:e2e -- acid-rain-socket-flow
const enabled = process.env.E2E_SOCKET_INTEGRATION === '1';
const describeFlow = enabled ? describe : describe.skip;

describeFlow('Acid-Rain real Socket.io flow (frontend#44)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let gameService: GameService;
  let aiPracticeService: AiPracticeService;
  let acidRainService: AcidRainService;
  let gateway: AcidRainGateway;
  let baseUrl: string;
  const fixtureSuffix = `${Date.now()}-${process.pid}`;
  const createdUserIds: string[] = [];
  const openSockets: Socket[] = [];
  // 개별 it()이 어서션 실패로 중간에 throw하면 그 매치 세션의 스폰/미스 루프
  // 타이머가 정리되지 못한 채 남아, afterAll의 app.close() 이후에도 계속 돌면서
  // DB 접근을 시도해 에러 로그가 무한히 쌓인다 — afterEach에서 항상 강제 종료한다.
  const roomsToCleanUp: string[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    await app.listen(0);
    const httpServer = app.getHttpServer() as import('http').Server;
    const address = httpServer.address();
    const port = address && typeof address === 'object' ? address.port : 3000;
    baseUrl = `http://127.0.0.1:${port}`;

    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
    gameService = app.get(GameService);
    aiPracticeService = app.get(AiPracticeService);
    acidRainService = app.get(AcidRainService);
    gateway = app.get(AcidRainGateway);
  });

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    for (const roomId of roomsToCleanUp.splice(0)) {
      if (acidRainService.getSession(roomId)) {
        try {
          await acidRainService.endMatch(roomId, 'FORFEIT', gateway.server);
        } catch {
          // 이미 종료 진행 중이었을 수 있음 — 정리 목적이므로 무시
        }
      }
    }
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await dataSource.getRepository(User).delete(createdUserIds);
    }
    await app.close();
  });

  async function createUser(label: string): Promise<User> {
    const repo = dataSource.getRepository(User);
    const user = await repo.save(
      repo.create({
        email: `e2e44-${label}-${fixtureSuffix}@example.test`,
        nickname: `E2E44 ${label} ${fixtureSuffix}`,
        status: UserStatus.OFFLINE,
      }),
    );
    createdUserIds.push(user.id);
    return user;
  }

  function tokenFor(user: User): string {
    return jwtService.sign({ sub: user.id });
  }

  // handleConnection이 client.data.userId를 채우기까지 내부적으로 유저 조회를
  // await하는 비동기 작업이라, 클라이언트의 'connect' 이벤트(전송 계층 핸드셰이크
  // 완료)가 먼저 발생하고 그 직후 join_room을 보내면 아직 인증 정보가 세팅되기 전이라
  // "Unauthorized"로 거부될 수 있다. 실제 브라우저 클라이언트는 연결 후 곧바로
  // 이벤트를 쏘지 않는 자연스러운 지연이 있어 잘 드러나지 않는 레이스인데, 테스트처럼
  // 연결 직후 바로 emit하면 재현된다 — 여기서 짧게 대기해 흡수한다.
  async function connectGameSocket(user: User): Promise<Socket> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = io(`${baseUrl}/game`, {
        path: '/socketio',
        transports: ['websocket'],
        forceNew: true,
        auth: { token: tokenFor(user) },
      });
      openSockets.push(s);
      s.once('connect', () => resolve(s));
      s.once('connect_error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return socket;
  }

  function waitForEvent<T = unknown>(
    socket: Socket,
    event: string,
  ): Promise<T> {
    return new Promise((resolve) => {
      socket.once(event, (payload: T) => resolve(payload));
    });
  }

  // 서비스단 damageForKeystrokes(private)와 동일한 공식 — word_cleared 데미지는
  // 단어에 주입한 damage 필드가 아니라 이 공식으로 keystrokes에서 재계산된다
  // (acid-rain.service.ts submitWord 참고). 기댓값 계산에 재사용한다.
  function damageForKeystrokes(keystrokes: number): number {
    return 5 + Math.ceil(keystrokes / 2);
  }

  // 랜덤 스폰을 기다리지 않고 결정론적으로 검증하기 위해, 세션에 직접 알려진
  // 텍스트/타건수의 단어를 주입한다 — 기존 ai-practice.server-flow.e2e-spec.ts와
  // 동일한 기법. 실제로 검증하려는 대상(소켓 이벤트 왕복)과는 무관한 스폰 알고리즘
  // 자체는 이 스펙의 범위가 아니다.
  function seedWord(
    roomId: string,
    wordId: string,
    text: string,
    keystrokes: number,
    landInMs = 60_000,
  ): void {
    const session = acidRainService.getSession(roomId);
    if (!session) throw new Error(`session not found for room ${roomId}`);
    const word: ActiveWord = {
      wordId,
      text,
      keystrokes,
      lane: 0,
      fallDurationMs: 6000,
      spawnedAt: new Date().toISOString(),
      landAt: Date.now() + landInMs,
      damage: damageForKeystrokes(keystrokes),
    };
    session.activeWords.set(wordId, word);
  }

  async function setUpPvpRoom(users: User[]): Promise<string> {
    const host = users[0];
    const room = await gameService.createRoom(
      host.id,
      host.nickname,
      users.length,
    );
    for (const guest of users.slice(1)) {
      await gameService.joinRoom(room.id, guest.id, guest.nickname);
    }
    for (const player of users) {
      await gameService.setReady(room.id, player.id, true);
    }
    return room.id;
  }

  // 매치가 IN_PROGRESS로 전이하는 순간부터 실제 스폰 루프가 돌기 시작해 임의의
  // 단어가 착지/미스되며 HP를 오염시킨다 — 상한(maxActiveWords)만큼 착지 시각이
  // 먼 미래인 더미 단어로 미리 채워두면 스폰 루프의 "이미 상한" 판정에 걸려 이후
  // 자연 스폰이 전혀 발생하지 않는다. 결정론적 HP/이벤트 검증을 위한 장치.
  function blockNaturalSpawns(roomId: string): void {
    const session = acidRainService.getSession(roomId);
    if (!session) throw new Error(`session not found for room ${roomId}`);
    // IN_PROGRESS 전이 직후 이 함수가 호출되기 전까지의 짧은 틈에도 스폰 루프가
    // 이미 자연 단어를 심어뒀을 수 있다 — landAt이 아직 안 지났더라도 나중에
    // 착지해 노이즈가 되므로, 채우기 전에 먼저 비운다.
    session.activeWords.clear();
    for (let i = 0; i < session.maxActiveWords; i++) {
      const wordId = `filler-${i}`;
      if (session.activeWords.has(wordId)) continue;
      session.activeWords.set(wordId, {
        wordId,
        text: `zzfiller${i}`,
        keystrokes: 8,
        lane: i % 5,
        fallDurationMs: 999_000,
        spawnedAt: new Date().toISOString(),
        landAt: Date.now() + 999_000,
        damage: 0,
      });
    }
  }

  it('2인 PvP: join_room → match_ready/match_start → word_submit(정답) → word_cleared/HP → KO → match_end → 전적 저장', async () => {
    const [alice, bob] = await Promise.all([
      createUser('alice'),
      createUser('bob'),
    ]);
    const roomId = await setUpPvpRoom([alice, bob]);
    roomsToCleanUp.push(roomId);

    const historyRepo = dataSource.getRepository(MatchHistory);
    const existingIds = new Set(
      (await historyRepo.find({ where: { mode: MatchMode.PVP } })).map(
        (r) => r.id,
      ),
    );

    const aliceSocket = await connectGameSocket(alice);
    const bobSocket = await connectGameSocket(bob);

    const aliceReady = waitForEvent<MatchReadyEventPayload>(
      aliceSocket,
      'match_ready',
    );
    const bobReady = waitForEvent<MatchReadyEventPayload>(
      bobSocket,
      'match_ready',
    );
    const aliceStart = waitForEvent(aliceSocket, 'match_start');

    aliceSocket.emit('join_room', { roomId });
    bobSocket.emit('join_room', { roomId });

    const [readyPayload] = await Promise.all([
      aliceReady,
      bobReady,
      aliceStart,
    ]);
    expect(readyPayload.participants).toHaveLength(2);

    // 카운트다운(3초) 종료까지 대기 — IN_PROGRESS로 전이해야 제출이 수락된다.
    await new Promise((resolve) => setTimeout(resolve, 3300));

    const session = acidRainService.getSession(roomId);
    expect(session?.status).toBe('IN_PROGRESS');
    // 인원수에 비례한 활성 단어 상한(#100) — 2인 기준 10개.
    expect(session?.maxActiveWords).toBe(10);

    // 자연 스폰을 완전히 차단해 이후 HP/이벤트 검증이 결정론적이 되도록 한다.
    blockNaturalSpawns(roomId);

    // ── 체크리스트 3/4: wordId 제출 → word_cleared + HP 반영, 동시 경합 시 제출 거부 ──
    const hpBeforeCorrect = session!.hpByParticipantId[bob.id];
    const correctKeystrokes = 'apple'.length;
    seedWord(roomId, 'w-correct', 'apple', correctKeystrokes);
    const bobSeesCleared = waitForEvent<WordClearedEventPayload>(
      bobSocket,
      'word_cleared',
    );
    const aliceSeesCleared = waitForEvent<WordClearedEventPayload>(
      aliceSocket,
      'word_cleared',
    );
    aliceSocket.emit('word_submit', {
      roomId,
      wordId: 'w-correct',
      text: 'apple',
      clientTs: Date.now(),
      attemptId: 'attempt-correct-1',
    });
    const [clearedForAlice, clearedForBob] = await Promise.all([
      aliceSeesCleared,
      bobSeesCleared,
    ]);
    expect(clearedForAlice.wordId).toBe('w-correct');
    expect(clearedForAlice.clearedBy).toBe(alice.id);
    expect(clearedForBob).toEqual(clearedForAlice);
    expect(clearedForAlice.hp[bob.id]).toBe(
      hpBeforeCorrect - damageForKeystrokes(correctKeystrokes),
    );

    // 같은 단어를 뒤늦게 제출하면 이미 사라졌으므로 거부되어야 한다(ALREADY_CLEARED).
    const bobRejected = waitForEvent<SubmitRejectedEventPayload>(
      bobSocket,
      'submit_rejected',
    );
    bobSocket.emit('word_submit', {
      roomId,
      wordId: 'w-correct',
      text: 'apple',
      clientTs: Date.now(),
      attemptId: 'attempt-correct-race',
    });
    const rejected = await bobRejected;
    expect(rejected.reason).toBe('ALREADY_CLEARED');

    // ── 체크리스트 4: word_missed 시 스플래시 데미지가 전원에게 반영 ──
    const hpBeforeMiss = session!.hpByParticipantId[bob.id];
    seedWord(roomId, 'w-missed', 'banana', 6, -100); // landAt이 이미 과거 → 다음 미스루프(200ms)에서 감지
    const aliceSeesMissed = waitForEvent<WordMissedEventPayload>(
      aliceSocket,
      'word_missed',
    );
    const missed = await aliceSeesMissed;
    expect(missed.wordId).toBe('w-missed');
    expect(missed.splashDamage).toBeGreaterThan(0);
    expect(missed.hp[bob.id]).toBe(hpBeforeMiss - missed.splashDamage);

    // ── 체크리스트 5: 재접속 시 state_sync로 활성 단어/경과시간 복구 ──
    const hpBeforeSync = session!.hpByParticipantId[bob.id];
    seedWord(roomId, 'w-sync', 'cherry', 6);
    aliceSocket.disconnect();
    const bobSeesDisconnect = waitForEvent(bobSocket, 'opponent_disconnected');
    await bobSeesDisconnect;

    const aliceReconnectSocket = await connectGameSocket(alice);
    const stateSync = waitForEvent<StateSyncEventPayload>(
      aliceReconnectSocket,
      'state_sync',
    );
    aliceReconnectSocket.emit('join_room', { roomId });
    const syncPayload = await stateSync;
    expect(syncPayload.activeWords.some((w) => w.wordId === 'w-sync')).toBe(
      true,
    );
    expect(syncPayload.elapsedMs).toBeGreaterThan(0);
    expect(syncPayload.hp[bob.id]).toBe(hpBeforeSync);

    // ── 체크리스트 1: KO로 매치 종료 → match_end 수신 → DB에 전적 저장 ──
    seedWord(roomId, 'w-ko', 'lethal', 400); // damageForKeystrokes(400)=205 — 잔여 HP와 무관하게 확실히 KO
    const bobSeesEnd = waitForEvent<MatchEndEventPayload>(
      bobSocket,
      'match_end',
    );
    aliceReconnectSocket.emit('word_submit', {
      roomId,
      wordId: 'w-ko',
      text: 'lethal',
      clientTs: Date.now(),
      attemptId: 'attempt-ko-1',
    });
    const endPayload = await bobSeesEnd;
    expect(endPayload.reason).toBe('KO');
    expect(endPayload.winnerId).toBe(alice.id);

    await new Promise((resolve) => setTimeout(resolve, 500)); // saveMatchHistory 트랜잭션 커밋 대기
    const newHistory = (
      await historyRepo.find({
        where: { mode: MatchMode.PVP },
        order: { createdAt: 'DESC' },
      })
    ).find((record) => !existingIds.has(record.id));
    expect(newHistory).toBeDefined();
    expect(acidRainService.getSession(roomId)).toBeUndefined();
  });

  it('4인 PvP: match_ready 참가자 4명 + 인원 비례 활성 단어 상한(20) 도달 시 스폰 skip', async () => {
    const users = await Promise.all([
      createUser('p1'),
      createUser('p2'),
      createUser('p3'),
      createUser('p4'),
    ]);
    const roomId = await setUpPvpRoom(users);
    roomsToCleanUp.push(roomId);

    const sockets = await Promise.all(users.map((u) => connectGameSocket(u)));
    const readyPromises = sockets.map((s) =>
      waitForEvent<MatchReadyEventPayload>(s, 'match_ready'),
    );
    sockets.forEach((s) => s.emit('join_room', { roomId }));
    const readyPayloads = await Promise.all(readyPromises);
    expect(readyPayloads[0].participants).toHaveLength(4);

    await new Promise((resolve) => setTimeout(resolve, 3300));
    const session = acidRainService.getSession(roomId);
    expect(session?.status).toBe('IN_PROGRESS');
    expect(session?.maxActiveWords).toBe(20); // WORDS_PER_PLAYER(5) * 4명 (#100)

    // 상한까지 인위적으로 채운 뒤, 스폰 루프가 최소 한 번 더 돌 시간(간격 최대 2000ms)을
    // 기다려도 활성 단어 수가 늘어나지 않아야 한다 — spawn skip 확인.
    for (let i = 0; i < session!.maxActiveWords; i++) {
      seedWord(roomId, `cap-word-${i}`, `w${i}`, 1);
    }
    const sizeAtCap = session!.activeWords.size;
    expect(sizeAtCap).toBe(20);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(acidRainService.getSession(roomId)!.activeWords.size).toBe(
      sizeAtCap,
    );

    await acidRainService.endMatch(roomId, 'FORFEIT', gateway.server);
  });

  it('1:1 AI practice: 로비 생성 → join_room → match_ready/match_start → AI와 실제 소켓으로 대전', async () => {
    const human = await createUser('ai-human');
    const created = await aiPracticeService.createAiPractice({
      ownerUserId: human.id,
      ownerNickname: human.nickname,
      ownerAvatar: human.avatar,
      requestId: `e2e44-ai-practice-${fixtureSuffix}`,
      difficulty: 'NORMAL',
    });
    expect(created.participants).toHaveLength(2);
    roomsToCleanUp.push(created.roomId);

    const humanSocket = await connectGameSocket(human);
    const ready = waitForEvent<MatchReadyEventPayload>(
      humanSocket,
      'match_ready',
    );
    const start = waitForEvent(humanSocket, 'match_start');
    humanSocket.emit('join_room', { roomId: created.roomId });
    const [readyPayload] = await Promise.all([ready, start]);
    expect(readyPayload.participants.some((p) => p.type === 'AI')).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 3300));
    const session = acidRainService.getSession(created.roomId);
    expect(session?.status).toBe('IN_PROGRESS');
    expect(session?.mode).toBe('AI_PRACTICE');

    await acidRainService.endMatch(created.roomId, 'FORFEIT', gateway.server);
  });
});
