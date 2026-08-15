import { ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { GameService } from '../game/game.service';
import { AiPracticeService } from '../game/ai-practice.service';
import { ChatGateway } from '../chat/chat.gateway';
import { LobbyGateway } from './lobby.gateway';
import { LobbyClient, LobbyService } from './lobby.service';
import type { AiPracticeCreatedPayload } from '../game/ai-practice.interface';

describe('LobbyGateway AI practice events', () => {
  let gateway: LobbyGateway;
  let gameService: {
    createRoom: jest.Mock;
    joinRoom: jest.Mock;
    getWaitingRooms: jest.Mock;
  };
  let aiPracticeService: {
    createAiPractice: jest.Mock;
    getActiveAiPracticeForUser: jest.Mock;
    cancelAiPractice: jest.Mock;
    assertNoActivePractice: jest.Mock;
  };
  let lobbyService: {
    sendTo: jest.Mock<void, [LobbyClient, string, unknown]>;
  };
  let client: LobbyClient;

  const createdPayload: AiPracticeCreatedPayload = {
    roomId: 'room-1',
    mode: 'AI_PRACTICE',
    difficulty: 'NORMAL',
    participants: [
      {
        participantId: 'user-1',
        userId: 'user-1',
        nickname: 'human',
        type: 'HUMAN',
      },
      {
        participantId: 'ai:room-1',
        nickname: 'ACID BOT',
        type: 'AI',
        aiDifficulty: 'NORMAL',
      },
    ],
    expiresAt: '2026-08-12T00:10:00.000Z',
  };

  beforeEach(() => {
    gameService = {
      createRoom: jest.fn(),
      joinRoom: jest.fn(),
      getWaitingRooms: jest.fn(),
    };
    aiPracticeService = {
      createAiPractice: jest.fn(),
      getActiveAiPracticeForUser: jest.fn(),
      cancelAiPractice: jest.fn(),
      assertNoActivePractice: jest.fn(),
    };
    lobbyService = {
      sendTo: jest.fn<void, [LobbyClient, string, unknown]>(),
    };
    gateway = new LobbyGateway(
      {} as JwtService,
      {} as UserService,
      gameService as unknown as GameService,
      aiPracticeService as unknown as AiPracticeService,
      lobbyService as unknown as LobbyService,
      { sendSystemMessage: jest.fn() } as unknown as ChatGateway,
    );
    client = {
      ws: {} as LobbyClient['ws'],
      userId: 'user-1',
      nickname: 'human',
    };
  });

  async function handle(type: string, payload?: unknown, target = client) {
    const callable = gateway as unknown as {
      handleMessage: (
        client: LobbyClient,
        msg: { type: string; payload?: unknown },
      ) => Promise<void>;
    };
    await callable.handleMessage(target, { type, payload });
  }

  it('creates AI practice through CREATE_AI_PRACTICE', async () => {
    aiPracticeService.createAiPractice.mockResolvedValue(createdPayload);

    await handle('CREATE_AI_PRACTICE', {
      requestId: 'request_123',
      difficulty: 'NORMAL',
    });

    expect(aiPracticeService.createAiPractice).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      ownerNickname: 'human',
      requestId: 'request_123',
      difficulty: 'NORMAL',
    });
    expect(lobbyService.sendTo).toHaveBeenCalledWith(
      client,
      'AI_PRACTICE_CREATED',
      createdPayload,
    );
  });

  it('does not create or join a public room while practice is active', async () => {
    aiPracticeService.assertNoActivePractice.mockRejectedValue(
      new ConflictException({
        code: 'ACTIVE_AI_PRACTICE_EXISTS',
        message: 'User already has an active AI practice session',
      }),
    );

    await expect(handle('CREATE_ROOM', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      handle('JOIN_ROOM', { roomId: 'public-room' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gameService.createRoom).not.toHaveBeenCalled();
    expect(gameService.joinRoom).not.toHaveBeenCalled();
  });

  it('rejects malformed requestId before calling the service', async () => {
    await handle('CREATE_AI_PRACTICE', {
      requestId: 'bad',
      difficulty: 'NORMAL',
    });

    expect(aiPracticeService.createAiPractice).not.toHaveBeenCalled();
    expect(lobbyService.sendTo).toHaveBeenCalledWith(
      client,
      'AI_PRACTICE_REJECTED',
      { code: 'INVALID_PAYLOAD', message: 'Invalid AI practice payload' },
    );
  });

  it('rejects invalid difficulty before calling the service', async () => {
    await handle('CREATE_AI_PRACTICE', {
      requestId: 'request_123',
      difficulty: 'EASY',
    });

    expect(aiPracticeService.createAiPractice).not.toHaveBeenCalled();
    expect(lobbyService.sendTo).toHaveBeenCalledWith(
      client,
      'AI_PRACTICE_REJECTED',
      {
        code: 'INVALID_DIFFICULTY',
        message: 'difficulty must be BEGINNER, NORMAL, or HARD',
      },
    );
  });

  it('rejects unauthenticated AI practice creation explicitly', async () => {
    await handle(
      'CREATE_AI_PRACTICE',
      { requestId: 'request_123', difficulty: 'NORMAL' },
      { ...client, userId: '', nickname: '' },
    );

    expect(aiPracticeService.createAiPractice).not.toHaveBeenCalled();
    expect(lobbyService.sendTo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '' }),
      'AI_PRACTICE_REJECTED',
      { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    );
  });

  it('maps service rejections to AI_PRACTICE_REJECTED', async () => {
    aiPracticeService.createAiPractice.mockRejectedValue(
      new ConflictException({
        code: 'ACTIVE_AI_PRACTICE_EXISTS',
        message: 'User already has an active AI practice session',
      }),
    );

    await handle('CREATE_AI_PRACTICE', {
      requestId: 'request_123',
      difficulty: 'NORMAL',
    });

    expect(lobbyService.sendTo).toHaveBeenCalledWith(
      client,
      'AI_PRACTICE_REJECTED',
      {
        code: 'ACTIVE_AI_PRACTICE_EXISTS',
        message: 'User already has an active AI practice session',
      },
    );
  });

  it('returns active practice through GET_ACTIVE_AI_PRACTICE', async () => {
    aiPracticeService.getActiveAiPracticeForUser.mockResolvedValue({
      ...createdPayload,
      ownerUserId: 'user-1',
      status: 'CREATED',
      createdAt: '2026-08-12T00:00:00.000Z',
    });

    await handle('GET_ACTIVE_AI_PRACTICE', {});

    expect(lobbyService.sendTo).toHaveBeenCalledWith(
      client,
      'AI_PRACTICE_CREATED',
      createdPayload,
    );
  });

  it('rejects GET_ACTIVE_AI_PRACTICE when no session exists', async () => {
    aiPracticeService.getActiveAiPracticeForUser.mockResolvedValue(null);

    await handle('GET_ACTIVE_AI_PRACTICE', {});

    expect(lobbyService.sendTo).toHaveBeenCalledWith(
      client,
      'AI_PRACTICE_REJECTED',
      {
        code: 'AI_PRACTICE_NOT_FOUND',
        message: 'AI practice session not found',
      },
    );
  });

  it('cleans active practice through explicit cancel without deleting on disconnect', async () => {
    aiPracticeService.getActiveAiPracticeForUser.mockResolvedValue({
      ...createdPayload,
      ownerUserId: 'user-1',
      status: 'CREATED',
      createdAt: '2026-08-12T00:00:00.000Z',
    });
    await handle('CANCEL_AI_PRACTICE', { roomId: 'room-1' });

    expect(aiPracticeService.cancelAiPractice).toHaveBeenCalledWith(
      'user-1',
      'room-1',
    );
    expect(lobbyService.sendTo).not.toHaveBeenCalledWith(
      client,
      'AI_PRACTICE_CREATED',
      expect.anything(),
    );
    expect(lobbyService.sendTo).toHaveBeenCalledWith(
      client,
      'AI_PRACTICE_CANCELLED',
      { roomId: 'room-1' },
    );
  });

  it('rejects a malformed cancel payload', async () => {
    await handle('CANCEL_AI_PRACTICE', { roomId: 42 });

    expect(aiPracticeService.cancelAiPractice).not.toHaveBeenCalled();
    expect(lobbyService.sendTo).toHaveBeenCalledWith(
      client,
      'AI_PRACTICE_REJECTED',
      { code: 'INVALID_PAYLOAD', message: 'Invalid AI practice payload' },
    );
  });
});

describe('LobbyGateway disconnect cleanup (#145)', () => {
  let gateway: LobbyGateway;
  let lobbyService: LobbyService;
  let gameService: {
    leaveRoom: jest.Mock;
    getWaitingRooms: jest.Mock;
    getRoom: jest.Mock;
  };
  let chatGateway: { sendSystemMessage: jest.Mock };

  function makeWs() {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const ws = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
      },
      readyState: 1,
      send: jest.fn(),
    };
    return { ws, handlers };
  }

  function connect(userId: string, nickname: string) {
    const { ws, handlers } = makeWs();
    (
      gateway as unknown as {
        onConnection: (ws: unknown, userId: string, nickname: string) => void;
      }
    ).onConnection(ws, userId, nickname);
    const client = lobbyService.findClientByUserId(userId);
    if (!client) throw new Error('client not registered');
    return { ws, handlers, client };
  }

  async function getRoom(client: LobbyClient, roomId: string) {
    const callable = gateway as unknown as {
      handleMessage: (
        client: LobbyClient,
        msg: { type: string; payload?: unknown },
      ) => Promise<void>;
    };
    await callable.handleMessage(client, {
      type: 'GET_ROOM',
      payload: { roomId },
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    lobbyService = new LobbyService();
    gameService = {
      leaveRoom: jest.fn().mockResolvedValue(null),
      getWaitingRooms: jest.fn().mockResolvedValue([]),
      getRoom: jest.fn().mockResolvedValue(null),
    };
    chatGateway = {
      sendSystemMessage: jest.fn().mockResolvedValue(undefined),
    };
    gateway = new LobbyGateway(
      {} as JwtService,
      {} as UserService,
      gameService as unknown as GameService,
      { assertNoActivePractice: jest.fn() } as unknown as AiPracticeService,
      lobbyService,
      chatGateway as unknown as ChatGateway,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('cleans up the old room when the user reconnects into a different room', async () => {
    const first = connect('user-1', 'aaa');
    first.client.roomId = 'room-A';

    first.handlers['close']();
    const second = connect('user-1', 'aaa');
    gameService.getRoom.mockResolvedValue({
      id: 'room-B',
      hostUserId: 'user-1',
      maxPlayers: 2,
      players: [],
      status: 'WAITING',
      createdAt: '2026-08-12T00:00:00.000Z',
    });
    await getRoom(second.client, 'room-B');

    jest.advanceTimersByTime(20000);
    await Promise.resolve();
    await Promise.resolve();

    expect(gameService.leaveRoom).toHaveBeenCalledWith('room-A', 'user-1');
  });

  it('skips cleanup when the user reconnects into the same room', async () => {
    const first = connect('user-1', 'aaa');
    first.client.roomId = 'room-A';

    first.handlers['close']();
    const second = connect('user-1', 'aaa');
    gameService.getRoom.mockResolvedValue({
      id: 'room-A',
      hostUserId: 'user-1',
      maxPlayers: 2,
      players: [],
      status: 'WAITING',
      createdAt: '2026-08-12T00:00:00.000Z',
    });
    await getRoom(second.client, 'room-A');

    jest.advanceTimersByTime(20000);
    await Promise.resolve();
    await Promise.resolve();

    expect(gameService.leaveRoom).not.toHaveBeenCalled();
  });

  it('cleans up when the user does not reconnect at all', async () => {
    const first = connect('user-1', 'aaa');
    first.client.roomId = 'room-A';

    first.handlers['close']();

    jest.advanceTimersByTime(20000);
    await Promise.resolve();
    await Promise.resolve();

    expect(gameService.leaveRoom).toHaveBeenCalledWith('room-A', 'user-1');
  });
});

describe('LobbyGateway SET_READY → GAME_START (#153)', () => {
  let gateway: LobbyGateway;
  let gameService: {
    setReady: jest.Mock;
    startGame: jest.Mock;
  };
  let lobbyService: {
    broadcast: jest.Mock<void, [string, unknown]>;
    clearRoomForAllClients: jest.Mock;
  };
  let client: LobbyClient;

  const readyRoom = (allReady: boolean) => ({
    id: 'room-1',
    hostUserId: 'user-1',
    maxPlayers: 2,
    players: [
      { userId: 'user-1', nickname: 'host', ready: true },
      { userId: 'user-2', nickname: 'guest', ready: allReady },
    ],
    status: 'WAITING',
    createdAt: '2026-08-12T00:00:00.000Z',
  });

  beforeEach(() => {
    gameService = {
      setReady: jest.fn(),
      startGame: jest.fn(),
    };
    lobbyService = {
      broadcast: jest.fn<void, [string, unknown]>(),
      clearRoomForAllClients: jest.fn(),
    };
    gateway = new LobbyGateway(
      {} as JwtService,
      {} as UserService,
      gameService as unknown as GameService,
      { assertNoActivePractice: jest.fn() } as unknown as AiPracticeService,
      lobbyService as unknown as LobbyService,
      { sendSystemMessage: jest.fn() } as unknown as ChatGateway,
    );
    client = {
      ws: {} as LobbyClient['ws'],
      userId: 'user-2',
      nickname: 'guest',
    };
  });

  async function handle(type: string, payload?: unknown) {
    const callable = gateway as unknown as {
      handleMessage: (
        client: LobbyClient,
        msg: { type: string; payload?: unknown },
      ) => Promise<void>;
    };
    await callable.handleMessage(client, { type, payload });
  }

  it('broadcasts GAME_START when everyone is ready, without touching room status itself (#153)', async () => {
    // 방 상태를 IN_GAME으로 바꾸는 책임은 AcidRainGateway.handleJoinRoom로 옮겨졌다 —
    // 여기서 미리 바꾸면 참가자 본인의 join_room이 "Room is not waiting"으로 거부되는
    // 회귀가 생긴다(#153 수정 중 실제로 재현/발견됨).
    gameService.setReady.mockResolvedValue(readyRoom(true));

    await handle('SET_READY', { roomId: 'room-1', ready: true });

    expect(gameService.startGame).not.toHaveBeenCalled();
    expect(lobbyService.broadcast).toHaveBeenCalledWith('GAME_START', {
      roomId: 'room-1',
    });
  });

  it('does not broadcast GAME_START while a player is still not ready', async () => {
    gameService.setReady.mockResolvedValue(readyRoom(false));

    await handle('SET_READY', { roomId: 'room-1', ready: false });

    expect(gameService.startGame).not.toHaveBeenCalled();
    expect(lobbyService.broadcast).not.toHaveBeenCalledWith(
      'GAME_START',
      expect.anything(),
    );
  });
});

describe('LobbyGateway host change announcement', () => {
  let gateway: LobbyGateway;
  let gameService: {
    leaveRoom: jest.Mock;
    getRoom: jest.Mock;
    getWaitingRooms: jest.Mock;
  };
  let lobbyService: {
    broadcast: jest.Mock<void, [string, unknown]>;
  };
  let chatGateway: { sendSystemMessage: jest.Mock };
  let client: LobbyClient;

  const roomWithHost = (hostUserId: string) => ({
    id: 'room-1',
    hostUserId,
    maxPlayers: 2,
    players: [
      { userId: 'user-1', nickname: 'host', ready: false },
      { userId: 'user-2', nickname: 'guest', ready: false },
    ],
    status: 'WAITING',
    createdAt: '2026-08-12T00:00:00.000Z',
  });

  beforeEach(() => {
    jest.useFakeTimers();
    gameService = {
      leaveRoom: jest.fn(),
      getRoom: jest.fn(),
      getWaitingRooms: jest.fn().mockResolvedValue([]),
    };
    lobbyService = {
      broadcast: jest.fn<void, [string, unknown]>(),
    };
    chatGateway = {
      sendSystemMessage: jest.fn().mockResolvedValue(undefined),
    };
    gateway = new LobbyGateway(
      {} as JwtService,
      {} as UserService,
      gameService as unknown as GameService,
      { assertNoActivePractice: jest.fn() } as unknown as AiPracticeService,
      lobbyService as unknown as LobbyService,
      chatGateway as unknown as ChatGateway,
    );
    client = {
      ws: {} as LobbyClient['ws'],
      userId: 'user-1',
      nickname: 'host',
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function handle(type: string, payload?: unknown) {
    const callable = gateway as unknown as {
      handleMessage: (
        client: LobbyClient,
        msg: { type: string; payload?: unknown },
      ) => Promise<void>;
    };
    await callable.handleMessage(client, { type, payload });
  }

  it('announces the new host when the host explicitly leaves via LEAVE_ROOM', async () => {
    gameService.getRoom.mockResolvedValue(roomWithHost('user-1'));
    gameService.leaveRoom.mockResolvedValue(roomWithHost('user-2'));

    await handle('LEAVE_ROOM', { roomId: 'room-1' });

    expect(chatGateway.sendSystemMessage).toHaveBeenCalledWith(
      'room-1',
      'guest 님이 호스트가 되었습니다.',
    );
  });

  it('does not announce a host change when a non-host explicitly leaves', async () => {
    client.userId = 'user-2';
    client.nickname = 'guest';
    gameService.getRoom.mockResolvedValue(roomWithHost('user-1'));
    gameService.leaveRoom.mockResolvedValue(roomWithHost('user-1'));

    await handle('LEAVE_ROOM', { roomId: 'room-1' });

    expect(chatGateway.sendSystemMessage).not.toHaveBeenCalledWith(
      'room-1',
      expect.stringContaining('호스트가 되었습니다'),
    );
  });

  it('announces the new host when the host disconnects and does not reconnect', async () => {
    const lobbyServiceReal = new LobbyService();
    gateway = new LobbyGateway(
      {} as JwtService,
      {} as UserService,
      gameService as unknown as GameService,
      { assertNoActivePractice: jest.fn() } as unknown as AiPracticeService,
      lobbyServiceReal,
      chatGateway as unknown as ChatGateway,
    );
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const ws = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
      },
      readyState: 1,
      send: jest.fn(),
    };
    (
      gateway as unknown as {
        onConnection: (ws: unknown, userId: string, nickname: string) => void;
      }
    ).onConnection(ws, 'user-1', 'host');
    const connectedClient = lobbyServiceReal.findClientByUserId('user-1');
    if (!connectedClient) throw new Error('client not registered');
    connectedClient.roomId = 'room-1';

    gameService.getRoom.mockResolvedValue(roomWithHost('user-1'));
    gameService.leaveRoom.mockResolvedValue(roomWithHost('user-2'));

    handlers['close']();
    jest.advanceTimersByTime(20000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chatGateway.sendSystemMessage).toHaveBeenCalledWith(
      'room-1',
      'guest 님이 호스트가 되었습니다.',
    );
  });

  it('does not send a duplicate leave message when explicit LEAVE_ROOM arrives after the disconnect grace timer was already armed (#201)', async () => {
    const lobbyServiceReal = new LobbyService();
    gateway = new LobbyGateway(
      {} as JwtService,
      {} as UserService,
      gameService as unknown as GameService,
      { assertNoActivePractice: jest.fn() } as unknown as AiPracticeService,
      lobbyServiceReal,
      chatGateway as unknown as ChatGateway,
    );
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const ws = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
      },
      readyState: 1,
      send: jest.fn(),
    };
    (
      gateway as unknown as {
        onConnection: (ws: unknown, userId: string, nickname: string) => void;
      }
    ).onConnection(ws, 'user-1', 'host');
    const connectedClient = lobbyServiceReal.findClientByUserId('user-1');
    if (!connectedClient) throw new Error('client not registered');
    connectedClient.roomId = 'room-1';

    gameService.getRoom.mockResolvedValue(roomWithHost('user-1'));
    gameService.leaveRoom.mockResolvedValue(roomWithHost('user-2'));

    // close 이벤트가 먼저 도착해 유예 타이머를 걸어둔 뒤(현실에선 프론트가
    // LEAVE_ROOM 전송 직후 바로 disconnect()를 호출하기 때문에 발생),
    // 명시적 LEAVE_ROOM 처리가 그 뒤에 도착하는 순서를 재현한다.
    handlers['close']();
    const callable = gateway as unknown as {
      handleMessage: (
        client: LobbyClient,
        msg: { type: string; payload?: unknown },
      ) => Promise<void>;
    };
    await callable.handleMessage(connectedClient, {
      type: 'LEAVE_ROOM',
      payload: { roomId: 'room-1' },
    });

    jest.advanceTimersByTime(20000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const leaveMessageCalls = chatGateway.sendSystemMessage.mock.calls.filter(
      ([, message]) => message === 'host 님이 방을 나갔습니다.',
    );
    expect(leaveMessageCalls).toHaveLength(1);
  });
});

describe('LobbyGateway JOIN_ROOM eviction (#183)', () => {
  let gateway: LobbyGateway;
  let gameService: {
    joinRoom: jest.Mock;
    getRoom: jest.Mock;
    getWaitingRooms: jest.Mock;
    findWaitingRoomsForUser: jest.Mock;
  };
  let lobbyService: {
    broadcast: jest.Mock<void, [string, unknown]>;
    sendTo: jest.Mock;
  };
  let chatGateway: { sendSystemMessage: jest.Mock };
  let client: LobbyClient;

  const oldRoom = (hostUserId: string, players: string[]) => ({
    id: 'old-room',
    hostUserId,
    maxPlayers: 4,
    players: players.map((userId) => ({
      userId,
      nickname: userId,
      ready: false,
    })),
    status: 'WAITING',
    createdAt: '2026-08-14T00:00:00.000Z',
  });

  const newRoom = {
    id: 'new-room',
    hostUserId: 'user-3',
    maxPlayers: 4,
    players: [
      { userId: 'user-3', nickname: 'user-3', ready: false },
      { userId: 'user-2', nickname: 'guest', ready: false },
    ],
    status: 'WAITING',
    createdAt: '2026-08-14T00:00:00.000Z',
  };

  beforeEach(() => {
    gameService = {
      joinRoom: jest.fn().mockResolvedValue(newRoom),
      getRoom: jest.fn().mockResolvedValue(null),
      getWaitingRooms: jest.fn().mockResolvedValue([]),
      findWaitingRoomsForUser: jest.fn().mockResolvedValue([]),
    };
    lobbyService = {
      broadcast: jest.fn<void, [string, unknown]>(),
      sendTo: jest.fn(),
    };
    chatGateway = {
      sendSystemMessage: jest.fn().mockResolvedValue(undefined),
    };
    gateway = new LobbyGateway(
      {} as JwtService,
      {} as UserService,
      gameService as unknown as GameService,
      { assertNoActivePractice: jest.fn() } as unknown as AiPracticeService,
      lobbyService as unknown as LobbyService,
      chatGateway as unknown as ChatGateway,
    );
    client = {
      ws: {} as LobbyClient['ws'],
      userId: 'user-2',
      nickname: 'guest',
    };
  });

  async function handle(type: string, payload?: unknown) {
    const callable = gateway as unknown as {
      handleMessage: (
        client: LobbyClient,
        msg: { type: string; payload?: unknown },
      ) => Promise<void>;
    };
    await callable.handleMessage(client, { type, payload });
  }

  it('notifies the old room (ROOM_UPDATED + leave message) when JOIN_ROOM evicts the user from it', async () => {
    gameService.findWaitingRoomsForUser.mockResolvedValue([
      oldRoom('user-1', ['user-1', 'user-2']),
    ]);
    gameService.getRoom.mockResolvedValue(oldRoom('user-1', ['user-1']));

    await handle('JOIN_ROOM', { roomId: 'new-room' });

    expect(gameService.findWaitingRoomsForUser).toHaveBeenCalledWith(
      'user-2',
      'new-room',
    );
    expect(chatGateway.sendSystemMessage).toHaveBeenCalledWith(
      'old-room',
      'guest 님이 방을 나갔습니다.',
    );
    const broadcastCalls = lobbyService.broadcast.mock.calls as [
      string,
      { room: { id: string } },
    ][];
    const updatedRoomIds = broadcastCalls
      .filter(([type]) => type === 'ROOM_UPDATED')
      .map(([, body]) => body.room.id);
    expect(updatedRoomIds).toEqual(
      expect.arrayContaining(['old-room', 'new-room']),
    );
  });

  it('broadcasts ROOM_CLOSED for the old room when eviction empties it', async () => {
    gameService.findWaitingRoomsForUser.mockResolvedValue([
      oldRoom('user-2', ['user-2']),
    ]);
    gameService.getRoom.mockResolvedValue(null);

    await handle('JOIN_ROOM', { roomId: 'new-room' });

    expect(lobbyService.broadcast).toHaveBeenCalledWith('ROOM_CLOSED', {
      roomId: 'old-room',
    });
  });

  it('announces a host change in the old room when the evicted user had been its host', async () => {
    gameService.findWaitingRoomsForUser.mockResolvedValue([
      oldRoom('user-2', ['user-2', 'user-4']),
    ]);
    gameService.getRoom.mockResolvedValue(oldRoom('user-4', ['user-4']));

    await handle('JOIN_ROOM', { roomId: 'new-room' });

    expect(chatGateway.sendSystemMessage).toHaveBeenCalledWith(
      'old-room',
      'user-4 님이 호스트가 되었습니다.',
    );
  });

  it('does not scan for other rooms when the user is already a member of the target room (idempotent re-join)', async () => {
    gameService.getRoom.mockResolvedValue(newRoom);

    await handle('JOIN_ROOM', { roomId: 'new-room' });

    expect(gameService.findWaitingRoomsForUser).not.toHaveBeenCalled();
  });

  it('does not send a duplicate leave message for an evicted room that already had a pending disconnect-grace timer (#201)', async () => {
    jest.useFakeTimers();
    try {
      const lobbyServiceReal = new LobbyService();
      gateway = new LobbyGateway(
        {} as JwtService,
        {} as UserService,
        gameService as unknown as GameService,
        { assertNoActivePractice: jest.fn() } as unknown as AiPracticeService,
        lobbyServiceReal,
        chatGateway as unknown as ChatGateway,
      );
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      const ws = {
        on: (event: string, cb: (...args: unknown[]) => void) => {
          handlers[event] = cb;
        },
        readyState: 1,
        send: jest.fn(),
      };
      (
        gateway as unknown as {
          onConnection: (
            ws: unknown,
            userId: string,
            nickname: string,
          ) => void;
        }
      ).onConnection(ws, 'user-2', 'guest');
      const connectedClient = lobbyServiceReal.findClientByUserId('user-2');
      if (!connectedClient) throw new Error('client not registered');
      connectedClient.roomId = 'old-room';

      // 먼저 old-room에서 소켓이 끊겨 유예 타이머가 걸린 상태를 만든 뒤(예:
      // 페이지 전환으로 소켓이 재생성되기 직전), 새 방으로 JOIN_ROOM하면서
      // old-room에서 강제 퇴장당하는 시나리오를 재현한다.
      handlers['close']();

      gameService.findWaitingRoomsForUser.mockResolvedValue([
        oldRoom('user-1', ['user-1', 'user-2']),
      ]);
      gameService.getRoom.mockResolvedValue(oldRoom('user-1', ['user-1']));

      const callable = gateway as unknown as {
        handleMessage: (
          client: LobbyClient,
          msg: { type: string; payload?: unknown },
        ) => Promise<void>;
      };
      await callable.handleMessage(connectedClient, {
        type: 'JOIN_ROOM',
        payload: { roomId: 'new-room' },
      });

      jest.advanceTimersByTime(20000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const leaveMessageCalls =
        chatGateway.sendSystemMessage.mock.calls.filter(
          ([, message]) => message === 'guest 님이 방을 나갔습니다.',
        );
      expect(leaveMessageCalls).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
