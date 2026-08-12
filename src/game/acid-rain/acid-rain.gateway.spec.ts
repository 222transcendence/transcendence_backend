import { JwtService } from '@nestjs/jwt';
import { Socket, Server } from 'socket.io';
import { RedisService } from '../../redis/redis.service';
import { UserService } from '../../user/user.service';
import { AcidRainGateway } from './acid-rain.gateway';
import { AcidRainService } from './acid-rain.service';
import { GameRoom, PlayerSession, RoomStatus } from '../game.interface';
import {
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
} from './acid-rain.interface';

interface GameSocketData {
  userId?: string;
  nickname?: string;
  roomId?: string;
}

describe('AcidRainGateway word_submit', () => {
  let gateway: AcidRainGateway;
  let acidRainService: {
    submitWord: jest.Mock<
      Promise<JudgeWordSubmitResult>,
      [JudgeWordSubmitInput, Server]
    >;
  };
  let clientEmit: jest.Mock<void, [string, unknown]>;
  let client: Socket;
  let server: Server;

  beforeEach(() => {
    acidRainService = {
      submitWord: jest.fn<
        Promise<JudgeWordSubmitResult>,
        [JudgeWordSubmitInput, Server]
      >(),
    };
    gateway = new AcidRainGateway(
      {} as JwtService,
      {} as UserService,
      {} as RedisService,
      acidRainService as unknown as AcidRainService,
    );
    server = {} as Server;
    gateway.server = server;

    clientEmit = jest.fn<void, [string, unknown]>();
    client = {
      data: { userId: 'host-id' },
      emit: clientEmit,
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
      targetUserId: 'guest-id',
      hp: { 'host-id': 100, 'guest-id': 93 },
      remainingPlayers: 2,
      gameEnded: false,
      winnerId: null,
      endReason: null,
      wordCleared: {
        wordId: 'w_1',
        clearedBy: 'host-id',
        targetUserId: 'guest-id',
        damage: 7,
        hp: { 'host-id': 100, 'guest-id': 93 },
      },
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
      hp: { 'host-id': 100, 'guest-id': 93 },
      gameEnded: false,
      winnerId: null,
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

  it('rejects with PLAYER_ELIMINATED-mapped submit_rejected for an already-eliminated player', async () => {
    acidRainService.submitWord.mockResolvedValue({
      accepted: false,
      roomId: 'room-1',
      playerId: 'host-id',
      wordId: 'w_1',
      reason: 'PLAYER_ELIMINATED',
      wordStateBefore: undefined,
      wordStateAfter: undefined,
      damage: 0,
      hp: { 'host-id': 0, 'guest-id': 100, 'p3-id': 80 },
      gameEnded: false,
      winnerId: null,
      endReason: null,
      submitRejected: { wordId: 'w_1', reason: 'NOT_FOUND' },
    });

    await gateway.handleWordSubmit(client, {
      roomId: 'room-1',
      wordId: 'w_1',
      text: '산성비',
      clientTs: 123,
    });

    expect(clientEmit).toHaveBeenCalledWith('submit_rejected', {
      wordId: 'w_1',
      reason: 'NOT_FOUND',
    });
  });
});

describe('AcidRainGateway join_room (N-player GameRoom shape)', () => {
  let gateway: AcidRainGateway;
  let acidRainService: {
    submitWord: jest.Mock;
    getSession: jest.Mock;
    handleReconnect: jest.Mock;
    startMatch: jest.Mock;
    handleDisconnect: jest.Mock;
    eliminateOnLeave: jest.Mock;
  };
  let redisService: { get: jest.Mock };
  let fetchSockets: jest.Mock;
  let toEmit: jest.Mock;
  let server: Server;
  let client: Socket;
  let clientData: GameSocketData;
  let joinFn: jest.Mock;

  const ROOM_ID = 'room-9';
  const players: PlayerSession[] = [
    { userId: 'u1-id', nickname: 'U1', ready: true },
    { userId: 'u2-id', nickname: 'U2', ready: true },
    { userId: 'u3-id', nickname: 'U3', ready: true },
  ];
  const room: GameRoom = {
    id: ROOM_ID,
    hostUserId: 'u1-id',
    maxPlayers: 3,
    status: RoomStatus.IN_GAME,
    players,
    createdAt: new Date(0).toISOString(),
  };

  beforeEach(() => {
    acidRainService = {
      submitWord: jest.fn(),
      getSession: jest.fn().mockReturnValue(undefined),
      handleReconnect: jest.fn(),
      startMatch: jest.fn().mockResolvedValue(undefined),
      handleDisconnect: jest.fn(),
      eliminateOnLeave: jest.fn().mockResolvedValue(undefined),
    };
    redisService = { get: jest.fn() };
    fetchSockets = jest.fn().mockResolvedValue([]);
    toEmit = jest.fn();
    const toSpy = jest.fn().mockReturnValue({ emit: toEmit });
    const inSpy = jest.fn().mockReturnValue({ fetchSockets });
    server = { to: toSpy, in: inSpy } as unknown as Server;

    gateway = new AcidRainGateway(
      {} as JwtService,
      {} as UserService,
      redisService as unknown as RedisService,
      acidRainService as unknown as AcidRainService,
    );
    gateway.server = server;

    joinFn = jest.fn().mockResolvedValue(undefined);
    clientData = { userId: 'u2-id', nickname: 'U2' };
    client = {
      data: clientData,
      join: joinFn,
      emit: jest.fn(),
    } as unknown as Socket;
  });

  it('throws when the room is not found in Redis', async () => {
    redisService.get.mockResolvedValue(null);

    await expect(
      gateway.handleJoinRoom(client, { roomId: ROOM_ID }),
    ).rejects.toThrow('Room not found');
  });

  it('throws when the authenticated user is not a participant of the room', async () => {
    redisService.get.mockResolvedValue(JSON.stringify(room));
    clientData.userId = 'intruder-id';

    await expect(
      gateway.handleJoinRoom(client, { roomId: ROOM_ID }),
    ).rejects.toThrow('Not a participant of this room');
  });

  it('reconnects via handleReconnect when a non-finished session already exists, without re-emitting match_ready or starting a new match', async () => {
    redisService.get.mockResolvedValue(JSON.stringify(room));
    acidRainService.getSession.mockReturnValue({ status: 'IN_PROGRESS' });

    await gateway.handleJoinRoom(client, { roomId: ROOM_ID });

    expect(acidRainService.handleReconnect).toHaveBeenCalledWith(
      ROOM_ID,
      'u2-id',
      server,
      client,
    );
    expect(acidRainService.startMatch).not.toHaveBeenCalled();
    expect(toEmit).not.toHaveBeenCalledWith(
      'match_ready',
      expect.anything(),
    );
  });

  it('waits for the full room.players.length quorum (not a hardcoded 2) before starting the match', async () => {
    redisService.get.mockResolvedValue(JSON.stringify(room)); // 3-player room
    fetchSockets.mockResolvedValue([{}, {}]); // only 2 of 3 sockets connected so far

    await gateway.handleJoinRoom(client, { roomId: ROOM_ID });

    expect(acidRainService.startMatch).not.toHaveBeenCalled();
    expect(toEmit).not.toHaveBeenCalledWith(
      'match_ready',
      expect.anything(),
    );
  });

  it('broadcasts match_ready with the full players array and starts the match once all room.players.length sockets have joined', async () => {
    redisService.get.mockResolvedValue(JSON.stringify(room)); // 3-player room
    fetchSockets.mockResolvedValue([{}, {}, {}]); // all 3 sockets connected

    await gateway.handleJoinRoom(client, { roomId: ROOM_ID });

    const expectedPlayers = [
      { userId: 'u1-id', nickname: 'U1' },
      { userId: 'u2-id', nickname: 'U2' },
      { userId: 'u3-id', nickname: 'U3' },
    ];
    expect(toEmit).toHaveBeenCalledWith('match_ready', {
      roomId: ROOM_ID,
      protocolVersion: '1.0',
      players: expectedPlayers,
    });
    expect(acidRainService.startMatch).toHaveBeenCalledWith(
      ROOM_ID,
      expectedPlayers,
      server,
    );
  });
});

describe('AcidRainGateway leave_room', () => {
  let gateway: AcidRainGateway;
  let acidRainService: {
    submitWord: jest.Mock;
    eliminateOnLeave: jest.Mock;
  };
  let leaveFn: jest.Mock;
  let client: Socket;
  let server: Server;

  const ROOM_ID = 'room-9';

  beforeEach(() => {
    acidRainService = {
      submitWord: jest.fn(),
      eliminateOnLeave: jest.fn().mockResolvedValue(undefined),
    };
    server = {} as Server;
    gateway = new AcidRainGateway(
      {} as JwtService,
      {} as UserService,
      {} as RedisService,
      acidRainService as unknown as AcidRainService,
    );
    gateway.server = server;

    leaveFn = jest.fn().mockResolvedValue(undefined);
    client = {
      data: { userId: 'u2-id', roomId: ROOM_ID },
      leave: leaveFn,
    } as unknown as Socket;
  });

  it('delegates to eliminateOnLeave with the authenticated user id and leaves the socket room', async () => {
    await gateway.handleLeaveRoom(client, { roomId: ROOM_ID });

    expect(acidRainService.eliminateOnLeave).toHaveBeenCalledWith(
      ROOM_ID,
      'u2-id',
      server,
    );
    expect(leaveFn).toHaveBeenCalledWith(`game:${ROOM_ID}`);
    expect((client.data as GameSocketData).roomId).toBeUndefined();
  });
});
