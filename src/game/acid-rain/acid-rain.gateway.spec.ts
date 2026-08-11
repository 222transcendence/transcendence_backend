import { JwtService } from '@nestjs/jwt';
import { Socket, Server } from 'socket.io';
import { RedisService } from '../../redis/redis.service';
import { UserService } from '../../user/user.service';
import { AcidRainGateway } from './acid-rain.gateway';
import { AcidRainService } from './acid-rain.service';
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
      targetHp: { host: 100, guest: 93 },
      gameEnded: false,
      winnerId: null,
      loserId: null,
      endReason: null,
      wordCleared: {
        wordId: 'w_1',
        clearedBy: 'host-id',
        damage: 7,
        targetHp: { host: 100, guest: 93 },
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
});
