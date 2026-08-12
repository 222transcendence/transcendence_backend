import { ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { GameService } from '../game/game.service';
import { AiPracticeService } from '../game/ai-practice.service';
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
