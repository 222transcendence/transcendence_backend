import { JwtService } from '@nestjs/jwt';
import { Socket, Server } from 'socket.io';
import { RedisService } from '../../redis/redis.service';
import { UserService } from '../../user/user.service';
import { AcidRainGateway } from './acid-rain.gateway';
import { AcidRainService } from './acid-rain.service';
import { AiPracticeService } from '../ai-practice.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { GameService } from '../game.service';
import { GameRoom, RoomStatus } from '../game.interface';
import { LobbyService } from '../../lobby/lobby.service';
import {
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
} from './acid-rain.interface';

describe('AcidRainGateway word_submit', () => {
  let gateway: AcidRainGateway;
  let acidRainService: {
    submitWord: jest.Mock<
      Promise<JudgeWordSubmitResult>,
      [JudgeWordSubmitInput, Server]
    >;
    getSession: jest.Mock;
    startMatch: jest.Mock;
    getSpectatorSnapshot: jest.Mock;
  };
  let redisService: { get: jest.Mock };
  let aiPracticeService: { getAiPracticeSession: jest.Mock };
  let chatGateway: { sendSystemMessage: jest.Mock };
  let clientEmit: jest.Mock<void, [string, unknown]>;
  let clientJoin: jest.Mock<Promise<void>, [string]>;
  let client: Socket;
  let server: Server;

  beforeEach(() => {
    acidRainService = {
      submitWord: jest.fn<
        Promise<JudgeWordSubmitResult>,
        [JudgeWordSubmitInput, Server]
      >(),
      getSession: jest.fn(),
      startMatch: jest.fn(),
      getSpectatorSnapshot: jest.fn(),
    };
    redisService = {
      get: jest.fn(),
    };
    aiPracticeService = {
      getAiPracticeSession: jest.fn(),
    };
    chatGateway = {
      sendSystemMessage: jest.fn().mockResolvedValue(undefined),
    };
    gateway = new AcidRainGateway(
      {} as JwtService,
      {} as UserService,
      redisService as unknown as RedisService,
      acidRainService as unknown as AcidRainService,
      aiPracticeService as unknown as AiPracticeService,
      chatGateway as unknown as ChatGateway,
      {} as GameService,
      {} as LobbyService,
    );
    server = {} as Server;
    gateway.server = server;

    clientEmit = jest.fn<void, [string, unknown]>();
    clientJoin = jest.fn<Promise<void>, [string]>();
    client = {
      data: { userId: 'host-id', nickname: 'host' },
      emit: clientEmit,
      join: clientJoin,
    } as unknown as Socket;
  });

  it('uses the shared submit entry point with the authenticated player id', async () => {
    const result: JudgeWordSubmitResult = {
      accepted: true,
      roomId: 'room-1',
      playerId: 'host-id',
      wordId: 'w_1',
      attemptId: 'attempt-1',
      wordStateBefore: 'ACTIVE',
      wordStateAfter: 'CLEARED',
      damage: 7,
      targetHpByParticipantId: { 'host-id': 100, 'guest-id': 93 },
      gameEnded: false,
      winnerId: null,
      loserId: null,
      endReason: null,
      wordCleared: {
        wordId: 'w_1',
        clearedBy: 'host-id',
        damage: 7,
        targetParticipantId: 'guest-id',
        hp: { 'host-id': 100, 'guest-id': 93 },
        targetHpByParticipantId: { 'host-id': 100, 'guest-id': 93 },
      },
      eliminatedParticipantIds: [],
    };
    acidRainService.submitWord.mockResolvedValue(result);

    await gateway.handleWordSubmit(client, {
      roomId: 'room-1',
      wordId: 'w_1',
      text: '산성비',
      clientTs: 123,
      attemptId: 'attempt-1',
    });

    expect(acidRainService.submitWord).toHaveBeenCalledWith(
      {
        roomId: 'room-1',
        playerId: 'host-id',
        wordId: 'w_1',
        text: '산성비',
        attemptId: 'attempt-1',
      },
      server,
    );
    expect(clientEmit).not.toHaveBeenCalled();
  });

  it('keeps submit_rejected private to the submitting socket', async () => {
    acidRainService.submitWord.mockResolvedValue({
      accepted: false,
      roomId: 'room-1',
      playerId: 'host-id',
      wordId: 'w_1',
      attemptId: 'attempt-1',
      reason: 'WORD_ALREADY_RESOLVED',
      wordStateBefore: 'CLEARED',
      wordStateAfter: 'CLEARED',
      damage: 0,
      targetHpByParticipantId: { 'host-id': 100, 'guest-id': 93 },
      gameEnded: false,
      winnerId: null,
      loserId: null,
      endReason: null,
      submitRejected: { wordId: 'w_1', reason: 'ALREADY_CLEARED' },
    });

    await gateway.handleWordSubmit(client, {
      roomId: 'room-1',
      wordId: 'w_1',
      text: '산성비',
      clientTs: 123,
      attemptId: 'attempt-1',
    });

    expect(clientEmit).toHaveBeenCalledWith('submit_rejected', {
      wordId: 'w_1',
      reason: 'ALREADY_CLEARED',
    });
  });

  it('rejects an invalid word_submit payload before hitting the service', async () => {
    await expect(
      gateway.handleWordSubmit(client, {
        roomId: 'room-1',
        wordId: 'w_1',
        text: '산성비',
        clientTs: 123,
      } as never),
    ).rejects.toThrow('Invalid word_submit payload');

    expect(acidRainService.submitWord).not.toHaveBeenCalled();
  });

  it('rejects word_submit from a spectator socket (#70)', async () => {
    const spectatorClient = {
      data: {
        userId: 'viewer-id',
        nickname: 'viewer',
        spectatingRoomId: 'room-1',
      },
      emit: jest.fn(),
      join: jest.fn(),
    } as unknown as Socket;

    await expect(
      gateway.handleWordSubmit(spectatorClient, {
        roomId: 'room-1',
        wordId: 'w_1',
        text: '산성비',
        clientTs: 123,
        attemptId: 'attempt-1',
      }),
    ).rejects.toThrow('Spectators cannot submit words');

    expect(acidRainService.submitWord).not.toHaveBeenCalled();
  });

  it('starts AI practice through the shared participant-aware match entry point', async () => {
    redisService.get.mockResolvedValue(null);
    aiPracticeService.getAiPracticeSession.mockResolvedValue({
      mode: 'AI_PRACTICE',
      roomId: 'practice-room',
      ownerUserId: 'host-id',
      difficulty: 'NORMAL',
      participants: [
        {
          participantId: 'host-id',
          userId: 'host-id',
          nickname: 'host',
          type: 'HUMAN',
        },
        {
          participantId: 'ai:practice-room',
          nickname: 'ACID BOT',
          type: 'AI',
          aiDifficulty: 'NORMAL',
        },
      ],
      status: 'CREATED',
      createdAt: '2026-08-12T00:00:00.000Z',
      expiresAt: '2026-08-12T00:10:00.000Z',
    });
    server.to = jest.fn().mockReturnValue({ emit: jest.fn() });
    clientJoin.mockResolvedValue(undefined);
    await gateway.handleJoinRoom(client, { roomId: 'practice-room' });
    expect(clientJoin).toHaveBeenCalledWith('game:practice-room');
    expect(acidRainService.startMatch).toHaveBeenCalledWith(
      'practice-room',
      server,
      expect.any(Array),
      'AI_PRACTICE',
    );
  });
});

describe('AcidRainGateway leave_room', () => {
  let gateway: AcidRainGateway;
  let acidRainService: {
    leaveMatch: jest.Mock<Promise<void>, [string, string, Server]>;
  };
  let redisService: { get: jest.Mock };
  let aiPracticeService: { getAiPracticeSession: jest.Mock };
  let chatGateway: { sendSystemMessage: jest.Mock };
  let gameService: {
    leaveRoom: jest.Mock<Promise<GameRoom | null>, [string, string]>;
  };
  let lobbyService: { broadcast: jest.Mock<void, [string, unknown]> };
  let clientLeave: jest.Mock<Promise<void>, [string]>;
  let client: Socket;
  let server: Server;

  const remainingRoom: GameRoom = {
    id: 'room-1',
    hostUserId: 'guest-id',
    maxPlayers: 4,
    status: RoomStatus.IN_GAME,
    players: [{ userId: 'guest-id', nickname: 'guest', ready: false }],
    createdAt: '2026-08-15T00:00:00.000Z',
  };

  beforeEach(() => {
    acidRainService = {
      leaveMatch: jest
        .fn<Promise<void>, [string, string, Server]>()
        .mockResolvedValue(undefined),
    };
    redisService = { get: jest.fn() };
    aiPracticeService = { getAiPracticeSession: jest.fn() };
    chatGateway = { sendSystemMessage: jest.fn().mockResolvedValue(undefined) };
    gameService = {
      leaveRoom: jest
        .fn<Promise<GameRoom | null>, [string, string]>()
        .mockResolvedValue(remainingRoom),
    };
    lobbyService = { broadcast: jest.fn<void, [string, unknown]>() };
    gateway = new AcidRainGateway(
      {} as JwtService,
      {} as UserService,
      redisService as unknown as RedisService,
      acidRainService as unknown as AcidRainService,
      aiPracticeService as unknown as AiPracticeService,
      chatGateway as unknown as ChatGateway,
      gameService as unknown as GameService,
      lobbyService as unknown as LobbyService,
    );
    server = {} as Server;
    gateway.server = server;

    clientLeave = jest.fn<Promise<void>, [string]>();
    client = {
      data: { userId: 'host-id', nickname: 'host' },
      leave: clientLeave,
    } as unknown as Socket;
  });

  it('delegates to the service-level forfeit instead of guessing a single opponent (N-player safe)', async () => {
    await gateway.handleLeaveRoom(client, { roomId: 'room-1' });

    expect(acidRainService.leaveMatch).toHaveBeenCalledWith(
      'room-1',
      'host-id',
      server,
    );
    expect(clientLeave).toHaveBeenCalledWith('game:room-1');
    expect((client.data as { roomId?: string }).roomId).toBeUndefined();
  });

  it('rejects leave_room from an unauthenticated socket', async () => {
    client = { data: {}, leave: clientLeave } as unknown as Socket;

    await expect(
      gateway.handleLeaveRoom(client, { roomId: 'room-1' }),
    ).rejects.toThrow('Unauthorized');
    expect(acidRainService.leaveMatch).not.toHaveBeenCalled();
  });

  it('removes the leaver from the lobby room.players so they stop appearing as a rejoinable member (#197)', async () => {
    await gateway.handleLeaveRoom(client, { roomId: 'room-1' });

    expect(gameService.leaveRoom).toHaveBeenCalledWith('room-1', 'host-id');
    expect(lobbyService.broadcast.mock.calls).toHaveLength(1);
    const [eventType, payload] = lobbyService.broadcast.mock.calls[0];
    expect(eventType).toBe('ROOM_UPDATED');
    const room = (payload as { room: { id: string; players: unknown[] } }).room;
    expect(room.id).toBe('room-1');
    expect(room.players).toEqual([
      expect.objectContaining({ userId: 'guest-id' }),
    ]);
  });

  it('broadcasts ROOM_CLOSED when the leaver was the last player in the lobby room (#197)', async () => {
    gameService.leaveRoom.mockResolvedValue(null);

    await gateway.handleLeaveRoom(client, { roomId: 'room-1' });

    expect(lobbyService.broadcast).toHaveBeenCalledWith('ROOM_CLOSED', {
      roomId: 'room-1',
    });
  });
});

describe('AcidRainGateway spectate_room (#70)', () => {
  let gateway: AcidRainGateway;
  let acidRainService: {
    getSpectatorSnapshot: jest.Mock;
    getLatestAiMonitorSnapshot: jest.Mock;
  };
  let redisService: { get: jest.Mock };
  let aiPracticeService: { getAiPracticeSession: jest.Mock };
  let chatGateway: { sendSystemMessage: jest.Mock };
  let clientEmit: jest.Mock<void, [string, unknown]>;
  let clientJoin: jest.Mock<Promise<void>, [string]>;
  let client: Socket;

  const snapshot = {
    roomId: 'room-1',
    participants: [
      {
        participantId: 'host-id',
        userId: 'host-id',
        nickname: 'host',
        type: 'HUMAN',
        hp: 80,
      },
      {
        participantId: 'guest-id',
        userId: 'guest-id',
        nickname: 'guest',
        type: 'HUMAN',
        hp: 65,
      },
    ],
    hp: { 'host-id': 80, 'guest-id': 65 },
    activeWords: [],
    elapsedMs: 12000,
    spawnIntervalMs: 2000,
    now: '2026-08-12T00:00:12.000Z',
  };

  beforeEach(() => {
    acidRainService = {
      getSpectatorSnapshot: jest.fn(),
      getLatestAiMonitorSnapshot: jest.fn(),
    };
    redisService = { get: jest.fn() };
    aiPracticeService = { getAiPracticeSession: jest.fn() };
    chatGateway = { sendSystemMessage: jest.fn().mockResolvedValue(undefined) };
    gateway = new AcidRainGateway(
      {} as JwtService,
      {} as UserService,
      redisService as unknown as RedisService,
      acidRainService as unknown as AcidRainService,
      aiPracticeService as unknown as AiPracticeService,
      chatGateway as unknown as ChatGateway,
      {} as GameService,
      {} as LobbyService,
    );
    gateway.server = {} as Server;

    clientEmit = jest.fn<void, [string, unknown]>();
    clientJoin = jest.fn<Promise<void>, [string]>();
    client = {
      data: { userId: 'viewer-id', nickname: 'viewer' },
      emit: clientEmit,
      join: clientJoin,
    } as unknown as Socket;
  });

  it('joins the socket room and sends a state_sync snapshot for an in-progress match', async () => {
    acidRainService.getSpectatorSnapshot.mockReturnValue(snapshot);
    acidRainService.getLatestAiMonitorSnapshot.mockReturnValue({
      roomId: 'room-1',
      participantId: 'ai:room-1',
      stateVersion: 7,
      timestamp: '2026-08-12T00:00:12.000Z',
      kind: 'FULL',
      currentDecision: {
        action: 'SELECT',
        phase: 'REACTION',
        targetWordId: 'word-1',
        previousTargetWordId: null,
      },
      profile: {
        wpm: 45,
        accuracy: 0.92,
        reactionTimeMs: 650,
        sampleCount: 0,
        confidence: 0,
        source: null,
      },
      executionProfile: {
        difficulty: 'NORMAL',
        typingWpm: 45,
        accuracy: 0.92,
        reactionDelayMs: 650,
        typoProbability: 0.08,
        correctionDelayMs: 150,
        abandonProbability: 0.06,
      },
      candidates: [],
      completedKeystrokes: 0,
      totalKeystrokes: 3,
    });

    await gateway.handleSpectateRoom(client, { roomId: 'room-1' });

    expect(acidRainService.getSpectatorSnapshot).toHaveBeenCalledWith('room-1');
    expect(clientJoin).toHaveBeenCalledWith('game:room-1');
    expect(clientEmit).toHaveBeenCalledWith('state_sync', snapshot);
    expect(clientEmit).toHaveBeenCalledWith(
      'ai_monitor_snapshot',
      expect.objectContaining({ roomId: 'room-1', kind: 'FULL' }),
    );
    expect(
      (client.data as { spectatingRoomId?: string }).spectatingRoomId,
    ).toBe('room-1');
    // 관전자는 참가자 전용 roomId 필드에는 절대 들어가지 않는다 (#145의 재발 방지 —
    // 이 필드가 섞이면 disconnect 시 FORFEIT 판정이 관전자를 참가자로 오인한다).
    expect((client.data as { roomId?: string }).roomId).toBeUndefined();
    expect(chatGateway.sendSystemMessage).toHaveBeenCalledWith(
      'room-1',
      expect.stringContaining('viewer'),
    );
  });

  it('rejects spectating a room that has no in-progress session', async () => {
    acidRainService.getSpectatorSnapshot.mockReturnValue(null);

    await expect(
      gateway.handleSpectateRoom(client, { roomId: 'room-1' }),
    ).rejects.toThrow('Room is not currently spectatable');

    expect(clientJoin).not.toHaveBeenCalled();
    expect(clientEmit).not.toHaveBeenCalled();
  });

  it('rejects an invalid spectate_room payload', async () => {
    await expect(
      gateway.handleSpectateRoom(client, {} as never),
    ).rejects.toThrow('Invalid spectate_room payload');

    expect(acidRainService.getSpectatorSnapshot).not.toHaveBeenCalled();
  });
});

describe('AcidRainGateway leave_spectate / disconnect (#70)', () => {
  let gateway: AcidRainGateway;
  let acidRainService: { getSpectatorSnapshot: jest.Mock };
  let redisService: { get: jest.Mock };
  let aiPracticeService: { getAiPracticeSession: jest.Mock };
  let chatGateway: { sendSystemMessage: jest.Mock };
  let clientLeave: jest.Mock<Promise<void>, [string]>;
  let client: Socket;

  beforeEach(() => {
    acidRainService = { getSpectatorSnapshot: jest.fn() };
    redisService = { get: jest.fn() };
    aiPracticeService = { getAiPracticeSession: jest.fn() };
    chatGateway = { sendSystemMessage: jest.fn().mockResolvedValue(undefined) };
    gateway = new AcidRainGateway(
      {} as JwtService,
      {} as UserService,
      redisService as unknown as RedisService,
      acidRainService as unknown as AcidRainService,
      aiPracticeService as unknown as AiPracticeService,
      chatGateway as unknown as ChatGateway,
      {} as GameService,
      {} as LobbyService,
    );
    gateway.server = {} as Server;

    clientLeave = jest.fn<Promise<void>, [string]>();
    client = {
      data: {
        userId: 'viewer-id',
        nickname: 'viewer',
        spectatingRoomId: 'room-1',
      },
      leave: clientLeave,
    } as unknown as Socket;
  });

  it('leaves the socket room, clears spectatingRoomId, and sends a leave system message', async () => {
    await gateway.handleLeaveSpectate(client, { roomId: 'room-1' });

    expect(clientLeave).toHaveBeenCalledWith('game:room-1');
    expect(
      (client.data as { spectatingRoomId?: string }).spectatingRoomId,
    ).toBeUndefined();
    expect(chatGateway.sendSystemMessage).toHaveBeenCalledWith(
      'room-1',
      expect.stringContaining('viewer'),
    );
  });

  it('rejects an invalid leave_spectate payload', async () => {
    await expect(
      gateway.handleLeaveSpectate(client, {} as never),
    ).rejects.toThrow('Invalid leave_spectate payload');

    expect(clientLeave).not.toHaveBeenCalled();
  });

  it('sends a leave system message on abrupt disconnect while spectating', () => {
    gateway.handleDisconnect(client);

    expect(chatGateway.sendSystemMessage).toHaveBeenCalledWith(
      'room-1',
      expect.stringContaining('viewer'),
    );
  });

  it('does not send a spectator leave message on disconnect when not spectating', () => {
    client = {
      data: { userId: 'viewer-id', nickname: 'viewer' },
    } as unknown as Socket;

    gateway.handleDisconnect(client);

    expect(chatGateway.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('does not send a duplicate leave message when the socket disconnects while handleLeaveSpectate is still awaiting sendSystemMessage (#202)', async () => {
    let resolveSendSystemMessage!: () => void;
    chatGateway.sendSystemMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSendSystemMessage = resolve;
      }),
    );

    const leavePromise = gateway.handleLeaveSpectate(client, {
      roomId: 'room-1',
    });

    // handleLeaveSpectate가 sendSystemMessage를 기다리는 도중, 클라이언트가
    // 끊겨 disconnect 핸들러가 끼어드는 상황을 재현한다.
    gateway.handleDisconnect(client);
    resolveSendSystemMessage();
    await leavePromise;

    expect(chatGateway.sendSystemMessage).toHaveBeenCalledTimes(1);
  });
});

describe('AcidRainGateway join_room concurrency (#144)', () => {
  let gateway: AcidRainGateway;
  let acidRainService: {
    getSession: jest.Mock;
    startMatch: jest.Mock;
    handleReconnect: jest.Mock;
  };
  let redisService: { get: jest.Mock };
  let aiPracticeService: { getAiPracticeSession: jest.Mock };
  let chatGateway: { sendSystemMessage: jest.Mock };
  let gameService: { startGame: jest.Mock };
  let lobbyService: { broadcast: jest.Mock<void, [string, unknown]> };
  let server: Server;
  let emitMock: jest.Mock;
  let joinedSockets: Set<string>;

  function makeClient(
    userId: string,
    nickname: string,
    socketId: string,
  ): Socket {
    return {
      id: socketId,
      data: { userId, nickname },
      join: jest.fn().mockImplementation(() => {
        joinedSockets.add(socketId);
        return Promise.resolve();
      }),
    } as unknown as Socket;
  }

  beforeEach(() => {
    joinedSockets = new Set();
    acidRainService = {
      getSession: jest.fn().mockReturnValue(undefined),
      startMatch: jest.fn().mockResolvedValue(undefined),
      handleReconnect: jest.fn(),
    };
    redisService = {
      get: jest.fn().mockResolvedValue(
        JSON.stringify({
          id: 'room-1',
          hostUserId: 'host-id',
          maxPlayers: 2,
          status: 'WAITING',
          players: [
            { userId: 'host-id', nickname: 'host', ready: true },
            { userId: 'guest-id', nickname: 'guest', ready: true },
          ],
          createdAt: '2026-08-12T00:00:00.000Z',
        }),
      ),
    };
    aiPracticeService = { getAiPracticeSession: jest.fn() };
    chatGateway = { sendSystemMessage: jest.fn().mockResolvedValue(undefined) };
    gameService = {
      startGame: jest.fn().mockResolvedValue({
        id: 'room-1',
        hostUserId: 'host-id',
        maxPlayers: 2,
        status: 'IN_GAME',
        players: [
          { userId: 'host-id', nickname: 'host', ready: true },
          { userId: 'guest-id', nickname: 'guest', ready: true },
        ],
        createdAt: '2026-08-12T00:00:00.000Z',
      }),
    };
    lobbyService = { broadcast: jest.fn<void, [string, unknown]>() };
    gateway = new AcidRainGateway(
      {} as JwtService,
      {} as UserService,
      redisService as unknown as RedisService,
      acidRainService as unknown as AcidRainService,
      aiPracticeService as unknown as AiPracticeService,
      chatGateway as unknown as ChatGateway,
      gameService as unknown as GameService,
      lobbyService as unknown as LobbyService,
    );

    emitMock = jest.fn();
    const toMock = jest.fn().mockReturnValue({ emit: emitMock });
    const inMock = jest.fn().mockImplementation(() => ({
      fetchSockets: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(Array.from(joinedSockets).map((id) => ({ id }))),
        ),
    }));
    server = { to: toMock, in: inMock } as unknown as Server;
    gateway.server = server;
  });

  it('broadcasts match_ready exactly once when both players join concurrently', async () => {
    const host = makeClient('host-id', 'host', 'socket-host');
    const guest = makeClient('guest-id', 'guest', 'socket-guest');

    await Promise.all([
      gateway.handleJoinRoom(host, { roomId: 'room-1' }),
      gateway.handleJoinRoom(guest, { roomId: 'room-1' }),
    ]);

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      'match_ready',
      expect.objectContaining({ roomId: 'room-1' }),
    );
    expect(acidRainService.startMatch).toHaveBeenCalledTimes(1);
  });

  it('transitions the room to IN_GAME and broadcasts ROOM_UPDATED to the lobby when the match actually starts (#153)', async () => {
    const host = makeClient('host-id', 'host', 'socket-host');
    const guest = makeClient('guest-id', 'guest', 'socket-guest');

    await Promise.all([
      gateway.handleJoinRoom(host, { roomId: 'room-1' }),
      gateway.handleJoinRoom(guest, { roomId: 'room-1' }),
    ]);

    expect(gameService.startGame).toHaveBeenCalledWith('room-1');
    const roomUpdatedCall = lobbyService.broadcast.mock.calls.find(
      ([type]) => type === 'ROOM_UPDATED',
    );
    expect(roomUpdatedCall?.[1]).toEqual({
      room: expect.objectContaining({
        id: 'room-1',
        status: 'IN_GAME',
      }) as unknown,
    });
  });
});
