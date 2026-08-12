import { JwtService } from '@nestjs/jwt';
import { Socket, Server } from 'socket.io';
import { RedisService } from '../../redis/redis.service';
import { UserService } from '../../user/user.service';
import { AcidRainGateway } from './acid-rain.gateway';
import { WsException } from '@nestjs/websockets';
import { AcidRainService } from './acid-rain.service';
import { AiPracticeService } from '../ai-practice.service';
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
  };
  let redisService: { get: jest.Mock };
  let aiPracticeService: { getAiPracticeSession: jest.Mock };
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
    };
    redisService = {
      get: jest.fn(),
    };
    aiPracticeService = {
      getAiPracticeSession: jest.fn(),
    };
    gateway = new AcidRainGateway(
      {} as JwtService,
      {} as UserService,
      redisService as unknown as RedisService,
      acidRainService as unknown as AcidRainService,
      aiPracticeService as unknown as AiPracticeService,
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
      targetHp: { host: 100, guest: 93 },
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
      targetHp: { host: 100, guest: 93 },
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

  it('recognizes AI practice metadata but does not start a match before #136', async () => {
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
    try {
      await gateway.handleJoinRoom(client, { roomId: 'practice-room' });
      throw new Error('Expected join_room to be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(WsException);
      expect((err as WsException).getError()).toEqual({
        code: 'AI_PRACTICE_NOT_READY',
        message: 'AI practice is not available yet',
      });
    }
    expect(clientJoin).not.toHaveBeenCalled();
    expect(acidRainService.startMatch).not.toHaveBeenCalled();
  });
});
