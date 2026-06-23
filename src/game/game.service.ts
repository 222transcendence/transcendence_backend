import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { User, UserStatus } from '../user/entities/user.entity';
import { Character } from './entities/character.entity';
import { Card, CardType } from './entities/card.entity';
import { MatchHistory } from './entities/match-history.entity';
import { GameRoom, RoomStatus, GamePhase } from './game.interface';
import {
  handleDrawPhase,
  handleMovePhase,
  handleResultPhase,
  rollDice,
} from './game-engine';
import { randomUUID } from 'crypto';

@Injectable()
export class GameService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Character)
    private readonly characterRepository: Repository<Character>,
    @InjectRepository(Card)
    private readonly cardRepository: Repository<Card>,
    @InjectRepository(MatchHistory)
    private readonly matchHistoryRepository: Repository<MatchHistory>,
    private readonly redisService: RedisService,
  ) {}

  /**
   * 방 생성 (Host)
   */
  async createRoom(
    hostUserId: string,
    hostNickname: string,
    characterId: number,
  ): Promise<GameRoom> {
    const roomId = randomUUID();
    const roomKey = `game:room:${roomId}`;

    // Host 유저 상태 검증 및 변경
    const hostUser = await this.userRepository.findOneBy({ id: hostUserId });
    if (!hostUser) throw new NotFoundException('Host user not found');
    hostUser.status = UserStatus.IN_GAME;
    await this.userRepository.save(hostUser);

    const room: GameRoom = {
      id: roomId,
      status: RoomStatus.WAITING,
      host: {
        userId: hostUserId,
        nickname: hostNickname,
        characterId,
        hp: 20,
        cardsInHand: [],
        cardsSubmitted: [],
      },
      distance: 3,
      currentTurn: 1,
      statusEffects: { host: [], guest: [] },
    };

    await this.redisService.set(roomKey, JSON.stringify(room));
    return room;
  }

  /**
   * 방 입장 (Guest) 및 즉시 게임 시작 세팅
   */
  async joinRoom(
    roomId: string,
    guestUserId: string,
    guestNickname: string,
    characterId: number,
  ): Promise<GameRoom> {
    const roomKey = `game:room:${roomId}`;
    const roomData = await this.redisService.get(roomKey);
    if (!roomData) throw new NotFoundException('Game room not found');

    const room = JSON.parse(roomData) as GameRoom;
    if (room.status !== RoomStatus.WAITING) {
      throw new BadRequestException('Room is not in WAITING status');
    }

    if (room.host.userId === guestUserId) {
      throw new BadRequestException('Cannot join your own room');
    }

    // Guest 유저 상태 변경
    const guestUser = await this.userRepository.findOneBy({ id: guestUserId });
    if (!guestUser) throw new NotFoundException('Guest user not found');
    guestUser.status = UserStatus.IN_GAME;
    await this.userRepository.save(guestUser);

    room.guest = {
      userId: guestUserId,
      nickname: guestNickname,
      characterId,
      hp: 20,
      cardsInHand: [],
      cardsSubmitted: [],
    };

    // 상태 READY -> 즉시 IN_GAME & DRAW 페이즈 시작
    room.status = RoomStatus.IN_GAME;
    room.phase = GamePhase.DRAW;

    // 초기 카드 5장씩 분배
    const hostInitialCards = await this.generateRandomCardIds(5);
    const guestInitialCards = await this.generateRandomCardIds(5);

    const updatedRoom = handleDrawPhase(
      room,
      hostInitialCards,
      guestInitialCards,
    );

    await this.redisService.set(roomKey, JSON.stringify(updatedRoom));
    return updatedRoom;
  }

  /**
   * 대기 중인 방 목록 조회
   */
  async getWaitingRooms(): Promise<GameRoom[]> {
    const client = this.redisService.getClient();
    const keys = await client.keys('game:room:*');
    const rooms: GameRoom[] = [];

    for (const key of keys) {
      const data = await this.redisService.get(key);
      if (data) {
        const room = JSON.parse(data) as GameRoom;
        if (room.status === RoomStatus.WAITING) {
          rooms.push(room);
        }
      }
    }
    return rooms;
  }

  /**
   * 카드 제출 처리
   */
  async submitCards(
    roomId: string,
    userId: string,
    cardIds: number[],
  ): Promise<GameRoom> {
    const roomKey = `game:room:${roomId}`;
    const roomData = await this.redisService.get(roomKey);
    if (!roomData) throw new NotFoundException('Game room not found');

    const room = JSON.parse(roomData) as GameRoom;
    if (room.status !== RoomStatus.IN_GAME) {
      throw new BadRequestException('Game is not in active state');
    }

    const isHost = room.host.userId === userId;
    const isGuest = room.guest && room.guest.userId === userId;

    if (!isHost && !isGuest) {
      throw new BadRequestException('You are not a participant in this room');
    }

    const player = isHost ? room.host : room.guest!;

    // 치팅 검증: 제출하는 카드가 실제로 손패에 있는지
    for (const cid of cardIds) {
      const idx = player.cardsInHand.indexOf(cid);
      if (idx === -1) {
        throw new BadRequestException(`Card ID ${cid} is not in your hand`);
      }
    }

    // 손패에서 제거 후 제출 목록에 등록
    cardIds.forEach((cid) => {
      const idx = player.cardsInHand.indexOf(cid);
      player.cardsInHand.splice(idx, 1);
    });
    player.cardsSubmitted = cardIds;

    // 양쪽 모두 제출 완료 시 페이즈 전이 처리
    if (
      room.host.cardsSubmitted.length > 0 &&
      room.guest &&
      room.guest.cardsSubmitted.length > 0
    ) {
      return await this.processPhaseTransition(room);
    }

    await this.redisService.set(roomKey, JSON.stringify(room));
    return room;
  }

  /**
   * 페이즈 전환 (State Machine 핵심 로직)
   */
  private async processPhaseTransition(room: GameRoom): Promise<GameRoom> {
    const roomKey = `game:room:${room.id}`;

    if (room.phase === GamePhase.MOVE) {
      // 1. MOVE 페이즈 연산
      const hostMoveVal = await this.calculateCardsValue(
        room.host.cardsSubmitted,
      );
      const guestMoveVal = await this.calculateCardsValue(
        room.guest.cardsSubmitted,
      );

      const nextRoom = handleMovePhase(room, hostMoveVal, guestMoveVal);
      await this.redisService.set(roomKey, JSON.stringify(nextRoom));
      return nextRoom;
    }

    if (room.phase === GamePhase.ATTACK) {
      // ATTACK -> DEFENSE 페이즈 전이 (공격 카드 제출 완료)
      room.phase = GamePhase.DEFENSE;
      // 제출 상태 임시 보관을 위해 리셋하지 않음 (DEFENSE에서 공격력을 연산하기 때문)
      await this.redisService.set(roomKey, JSON.stringify(room));
      return room;
    }

    if (room.phase === GamePhase.DEFENSE) {
      // DEFENSE -> RESULT 페이즈로 이동하여 바로 데미지 연산 수행
      room.phase = GamePhase.RESULT;

      // 주사위 개수 산출을 위해 캐릭터 베이스 스탯 조회
      const hostChar = await this.getCharacterOrDefault(room.host.characterId);
      const guestChar = await this.getCharacterOrDefault(
        room.guest!.characterId,
      );

      // 공격 및 방어 카드 밸류 합산
      const hostAtkCardVal = await this.calculateCardsValue(
        room.host.cardsSubmitted,
        CardType.ATK_SWORD,
      );
      const guestAtkCardVal = await this.calculateCardsValue(
        room.guest!.cardsSubmitted,
        CardType.ATK_SWORD,
      );
      const hostDefCardVal = await this.calculateCardsValue(
        room.host.cardsSubmitted,
        CardType.DEF,
      );
      const guestDefCardVal = await this.calculateCardsValue(
        room.guest!.cardsSubmitted,
        CardType.DEF,
      );

      const hostAtkTotal = hostChar.base_atk + hostAtkCardVal;
      const guestAtkTotal = guestChar.base_atk + guestAtkCardVal;
      const hostDefTotal = hostChar.base_def + hostDefCardVal;
      const guestDefTotal = guestChar.base_def + guestDefCardVal;

      const nextRoom = handleResultPhase(
        room,
        hostAtkTotal,
        hostDefTotal,
        guestAtkTotal,
        guestDefTotal,
        (cnt) => rollDice(cnt),
      );

      // 게임이 끝났다면 DB 기록 및 유저 상태 복구
      if (nextRoom.status === RoomStatus.FINISHED) {
        await this.recordMatchHistory(nextRoom);
      } else if (nextRoom.phase === GamePhase.DRAW) {
        // 다음 턴 복구 후 카드 자동 드로우 보충
        const hostCardsToDraw = 5 - nextRoom.host.cardsInHand.length;
        const guestCardsToDraw = 5 - nextRoom.guest!.cardsInHand.length;

        if (hostCardsToDraw > 0) {
          nextRoom.host.cardsInHand.push(
            ...(await this.generateRandomCardIds(hostCardsToDraw)),
          );
        }
        if (guestCardsToDraw > 0) {
          nextRoom.guest!.cardsInHand.push(
            ...(await this.generateRandomCardIds(guestCardsToDraw)),
          );
        }
        // 드로우가 끝났으므로 다시 MOVE 페이즈로 전환
        nextRoom.phase = GamePhase.MOVE;
      }

      await this.redisService.set(roomKey, JSON.stringify(nextRoom));
      return nextRoom;
    }

    return room;
  }

  /**
   * 카드들의 총 가치 계산
   */
  private async calculateCardsValue(
    cardIds: number[],
    filterType?: CardType,
  ): Promise<number> {
    let sum = 0;
    for (const cid of cardIds) {
      const card = await this.getCardOrDefault(cid);
      if (!filterType || card.type === filterType) {
        // MOVE 또는 ATK인 경우 value_top 사용, DEF인 경우 value_bottom 사용
        sum += card.type === CardType.DEF ? card.value_bottom : card.value_top;
      }
    }
    return sum;
  }

  /**
   * 캐릭터 획득 혹은 기본 캐릭터 반환 (Fallback)
   */
  private async getCharacterOrDefault(characterId: number): Promise<Character> {
    const character = await this.characterRepository.findOneBy({
      id: characterId,
    });
    if (character) return character;
    return {
      id: characterId,
      name: `Fallback Character ${characterId}`,
      base_hp: 20,
      base_atk: 3,
      base_def: 2,
      skills: {},
    };
  }

  /**
   * 카드 획득 혹은 기본 카드 반환 (Fallback)
   */
  private async getCardOrDefault(cardId: number): Promise<Card> {
    const card = await this.cardRepository.findOneBy({ id: cardId });
    if (card) return card;

    // 홀수는 공격 카드, 짝수는 방어 카드, 3의 배수는 이동 카드로 매핑하는 Fallback 생성
    let type = CardType.MOVE;
    if (cardId % 3 === 0) {
      type = CardType.MOVE;
    } else if (cardId % 2 === 0) {
      type = CardType.DEF;
    } else {
      type = CardType.ATK_SWORD;
    }

    return {
      id: cardId,
      type,
      value_top: (cardId % 4) + 1,
      value_bottom: (cardId % 3) + 1,
    };
  }

  /**
   * 무작위 카드 ID 리스트 생성
   */
  private async generateRandomCardIds(count: number): Promise<number[]> {
    await Promise.resolve();
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      // 1 ~ 100 사이의 가상 카드 ID 부여
      ids.push(Math.floor(Math.random() * 100) + 1);
    }
    return ids;
  }

  /**
   * 매치 이력 DB 저장 및 유저 승패 갱신
   */
  private async recordMatchHistory(room: GameRoom): Promise<void> {
    const host = await this.userRepository.findOneBy({ id: room.host.userId });
    const guest = await this.userRepository.findOneBy({
      id: room.guest!.userId,
    });
    if (!host || !guest) return;

    // 유저 전적 갱신
    if (room.winnerId === host.id) {
      host.wins++;
      guest.losses++;
    } else if (room.winnerId === guest.id) {
      guest.wins++;
      host.losses++;
    }

    host.status = UserStatus.ONLINE;
    guest.status = UserStatus.ONLINE;

    await this.userRepository.save(host);
    await this.userRepository.save(guest);

    // 역사 저장
    const history = this.matchHistoryRepository.create({
      host_user: host,
      guest_user: guest,
      winner:
        room.winnerId === host.id
          ? host
          : room.winnerId === guest.id
            ? guest
            : undefined,
      turns_played: room.currentTurn,
      match_data: {
        winnerId: room.winnerId,
        finalHostHp: room.host.hp,
        finalGuestHp: room.guest!.hp,
      },
    });

    await this.matchHistoryRepository.save(history);
  }
}
