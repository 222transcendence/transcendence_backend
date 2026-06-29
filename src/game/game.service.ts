import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { User, UserStatus } from '../user/entities/user.entity';
import { Character, CharacterName } from './entities/character.entity';
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
    const playerEffects = isHost ? room.statusEffects.host : room.statusEffects.guest;
    const isStunned = playerEffects && playerEffects.some((eff) => eff.type === 'STUN');

    if (isStunned && cardIds.length > 0) {
      throw new BadRequestException('기절(STUN) 상태에서는 카드를 제출할 수 없습니다.');
    }

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

    // 캐릭터 및 카드 정보 미리 로드
    const hostChar = await this.getCharacterOrDefault(room.host.characterId);
    const guestChar = await this.getCharacterOrDefault(room.guest!.characterId);

    const hostSubmittedCards = await this.getCardsFromIds(room.host.cardsSubmitted);
    const guestSubmittedCards = await this.getCardsFromIds(room.guest!.cardsSubmitted);

    if (room.phase === GamePhase.MOVE) {
      // 1. 도적 스킬 Shadowstep 체크: MOVE 카드 2장 제출 시 이동력 +2
      let hostMoveBonus = 0;
      let guestMoveBonus = 0;

      if (hostChar.name === 'ROGUE') {
        const moveCardsCount = hostSubmittedCards.filter((c) => c.type === CardType.MOVE).length;
        if (moveCardsCount >= 2) {
          hostMoveBonus += 2;
          room.lastActionLog = room.lastActionLog || [];
          room.lastActionLog.push(`[SKILL] ${room.host.nickname} (도적)의 Shadowstep 발동! 이동력 +2`);
        }
      }
      if (guestChar.name === 'ROGUE') {
        const moveCardsCount = guestSubmittedCards.filter((c) => c.type === CardType.MOVE).length;
        if (moveCardsCount >= 2) {
          guestMoveBonus += 2;
          room.lastActionLog = room.lastActionLog || [];
          room.lastActionLog.push(`[SKILL] ${room.guest!.nickname} (도적)의 Shadowstep 발동! 이동력 +2`);
        }
      }

      // 기본 이동값 계산
      const hostMoveVal = hostSubmittedCards
        .filter((c) => c.type === CardType.MOVE)
        .reduce((sum, c) => sum + c.valueTop, 0) + hostMoveBonus;

      const guestMoveVal = guestSubmittedCards
        .filter((c) => c.type === CardType.MOVE)
        .reduce((sum, c) => sum + c.valueTop, 0) + guestMoveBonus;

      // MOVE 페이즈 실행
      let nextRoom = handleMovePhase(room, hostMoveVal, guestMoveVal);

      // 2. 독/재생 상태이상 정산
      nextRoom = await this.applyPoisonAndRegen(nextRoom, hostChar, guestChar);

      // 누군가 사망했다면 즉시 종료
      if (nextRoom.status === RoomStatus.FINISHED) {
        await this.recordMatchHistory(nextRoom);
      }

      await this.redisService.set(roomKey, JSON.stringify(nextRoom));
      return nextRoom;
    }

    if (room.phase === GamePhase.ATTACK) {
      // 1. 마법사 스킬 Fireball 체크: SPECIAL 카드 2장 제출 시 다음 RESULT 페이즈에서 공격 주사위 +2 버프 부여
      if (hostChar.name === 'MAGE') {
        const specialCount = hostSubmittedCards.filter((c) => c.type === CardType.SPECIAL).length;
        if (specialCount >= 2) {
          room.statusEffects.host.push({ type: 'FIREBALL_BUFF' as any, duration: 1 });
          room.lastActionLog = room.lastActionLog || [];
          room.lastActionLog.push(`[SKILL] ${room.host.nickname} (마법사)의 Fireball 발동! 다음 전투에서 공격 주사위 롤 +2`);
        }
      }
      if (guestChar.name === 'MAGE') {
        const specialCount = guestSubmittedCards.filter((c) => c.type === CardType.SPECIAL).length;
        if (specialCount >= 2) {
          room.statusEffects.guest.push({ type: 'FIREBALL_BUFF' as any, duration: 1 });
          room.lastActionLog = room.lastActionLog || [];
          room.lastActionLog.push(`[SKILL] ${room.guest!.nickname} (마법사)의 Fireball 발동! 다음 전투에서 공격 주사위 롤 +2`);
        }
      }

      // 2. 마법사 스킬 Curse 체크: SPECIAL 카드 1장 제출 시 상대방에게 2턴 독(POISON) 부여
      if (hostChar.name === 'MAGE') {
        const specialCount = hostSubmittedCards.filter((c) => c.type === CardType.SPECIAL).length;
        if (specialCount >= 1) {
          room.statusEffects.guest.push({ type: 'POISON', duration: 2 });
          room.lastActionLog = room.lastActionLog || [];
          room.lastActionLog.push(`[SKILL] ${room.host.nickname} (마법사)의 Curse 발동! 상대방에게 2턴간 독(POISON) 부여`);
        }
      }
      if (guestChar.name === 'MAGE') {
        const specialCount = guestSubmittedCards.filter((c) => c.type === CardType.SPECIAL).length;
        if (specialCount >= 1) {
          room.statusEffects.host.push({ type: 'POISON', duration: 2 });
          room.lastActionLog = room.lastActionLog || [];
          room.lastActionLog.push(`[SKILL] ${room.guest!.nickname} (마법사)의 Curse 발동! 상대방에게 2턴간 독(POISON) 부여`);
        }
      }

      // ATTACK -> DEFENSE 페이즈 전이
      room.phase = GamePhase.DEFENSE;
      await this.redisService.set(roomKey, JSON.stringify(room));
      return room;
    }

    if (room.phase === GamePhase.DEFENSE) {
      room.phase = GamePhase.RESULT;

      // 1. 전사 스킬 Shield Bash 체크: DEF 카드 2장 제출 시 상대에게 다음 턴 1턴 기절(STUN) 부여
      if (hostChar.name === 'WARRIOR') {
        const defCount = hostSubmittedCards.filter((c) => c.type === CardType.DEF).length;
        if (defCount >= 2) {
          room.statusEffects.guest.push({ type: 'STUN', duration: 1 });
          room.lastActionLog = room.lastActionLog || [];
          room.lastActionLog.push(`[SKILL] ${room.host.nickname} (전사)의 Shield Bash 발동! 상대방에게 다음 턴 1턴 기절(STUN) 부여`);
        }
      }
      if (guestChar.name === 'WARRIOR') {
        const defCount = guestSubmittedCards.filter((c) => c.type === CardType.DEF).length;
        if (defCount >= 2) {
          room.statusEffects.host.push({ type: 'STUN', duration: 1 });
          room.lastActionLog = room.lastActionLog || [];
          room.lastActionLog.push(`[SKILL] ${room.guest!.nickname} (전사)의 Shield Bash 발동! 상대방에게 다음 턴 1턴 기절(STUN) 부여`);
        }
      }

      // 2. 도적 스킬 Dismantle 체크: SPECIAL 카드 1장 제출 시 상대방 손패 1장 무작위 파괴
      if (hostChar.name === 'ROGUE') {
        const specialCount = hostSubmittedCards.filter((c) => c.type === CardType.SPECIAL).length;
        if (specialCount >= 1 && room.guest!.cardsInHand.length > 0) {
          const randIdx = Math.floor(Math.random() * room.guest!.cardsInHand.length);
          const removedCid = room.guest!.cardsInHand.splice(randIdx, 1)[0];
          room.lastActionLog = room.lastActionLog || [];
          room.lastActionLog.push(`[SKILL] ${room.host.nickname} (도적)의 Dismantle 발동! 상대방의 손패에서 카드 ID ${removedCid} 파괴`);
        }
      }
      if (guestChar.name === 'ROGUE') {
        const specialCount = guestSubmittedCards.filter((c) => c.type === CardType.SPECIAL).length;
        if (specialCount >= 1 && room.host.cardsInHand.length > 0) {
          const randIdx = Math.floor(Math.random() * room.host.cardsInHand.length);
          const removedCid = room.host.cardsInHand.splice(randIdx, 1)[0];
          room.lastActionLog = room.lastActionLog || [];
          room.lastActionLog.push(`[SKILL] ${room.guest!.nickname} (도적)의 Dismantle 발동! 상대방의 손패에서 카드 ID ${removedCid} 파괴`);
        }
      }

      // Fireball 버프 공격력 산출
      let hostAtkBuff = 0;
      let guestAtkBuff = 0;

      if (room.statusEffects.host.some((eff) => (eff.type as any) === 'FIREBALL_BUFF')) {
        hostAtkBuff += 2;
      }
      if (room.statusEffects.guest.some((eff) => (eff.type as any) === 'FIREBALL_BUFF')) {
        guestAtkBuff += 2;
      }

      // 카드 값 계산
      const hostAtkCardVal = await this.calculateCardsValue(room.host.cardsSubmitted, CardType.ATK_SWORD);
      const guestAtkCardVal = await this.calculateCardsValue(room.guest!.cardsSubmitted, CardType.ATK_SWORD);
      const hostDefCardVal = await this.calculateCardsValue(room.host.cardsSubmitted, CardType.DEF);
      const guestDefCardVal = await this.calculateCardsValue(room.guest!.cardsSubmitted, CardType.DEF);

      const hostAtkTotal = hostChar.baseAtk + hostAtkCardVal + hostAtkBuff;
      const guestAtkTotal = guestChar.baseAtk + guestAtkCardVal + guestAtkBuff;
      const hostDefTotal = hostChar.baseDef + hostDefCardVal;
      const guestDefTotal = guestChar.baseDef + guestDefCardVal;

      let nextRoom = handleResultPhase(
        room,
        hostAtkTotal,
        hostDefTotal,
        guestAtkTotal,
        guestDefTotal,
      );

      // 게임 종료 처리
      if (nextRoom.status === RoomStatus.FINISHED) {
        await this.recordMatchHistory(nextRoom);
      } else if (nextRoom.phase === GamePhase.DRAW) {
        // 3. 전사 스킬 Second Wind 체크: DRAW 시작 시 HP 5 이하이면 +3 HP 회복
        if (hostChar.name === 'WARRIOR') {
          if (nextRoom.host.hp > 0 && nextRoom.host.hp <= 5) {
            nextRoom.host.hp = Math.min(hostChar.baseHp, nextRoom.host.hp + 3);
            nextRoom.lastActionLog = nextRoom.lastActionLog || [];
            nextRoom.lastActionLog.push(`[SKILL] ${nextRoom.host.nickname} (전사)의 Second Wind 발동! HP +3 회복 (HP: ${nextRoom.host.hp})`);
          }
        }
        if (guestChar.name === 'WARRIOR') {
          if (nextRoom.guest!.hp > 0 && nextRoom.guest!.hp <= 5) {
            nextRoom.guest!.hp = Math.min(guestChar.baseHp, nextRoom.guest!.hp + 3);
            nextRoom.lastActionLog = nextRoom.lastActionLog || [];
            nextRoom.lastActionLog.push(`[SKILL] ${nextRoom.guest!.nickname} (전사)의 Second Wind 발동! HP +3 회복 (HP: ${nextRoom.guest!.hp})`);
          }
        }

        // 4. 상태이상 duration 감소 및 필터링
        nextRoom.statusEffects.host.forEach((eff) => eff.duration--);
        nextRoom.statusEffects.guest.forEach((eff) => eff.duration--);

        nextRoom.statusEffects.host = nextRoom.statusEffects.host.filter((eff) => eff.duration > 0);
        nextRoom.statusEffects.guest = nextRoom.statusEffects.guest.filter((eff) => eff.duration > 0);

        // 카드 드로우
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
        nextRoom.phase = GamePhase.MOVE;
      }

      await this.redisService.set(roomKey, JSON.stringify(nextRoom));
      return nextRoom;
    }

    return room;
  }

  /**
   * 독(POISON) 및 재생(REGEN) 상태이상을 정산합니다.
   */
  private async applyPoisonAndRegen(
    room: GameRoom,
    hostChar: Character,
    guestChar: Character,
  ): Promise<GameRoom> {
    if (!room.guest) return room;
    room.lastActionLog = room.lastActionLog || [];

    // Host 정산
    const hostPoisons = room.statusEffects.host.filter((eff) => eff.type === 'POISON').length;
    const hostRegens = room.statusEffects.host.filter((eff) => eff.type === 'REGEN').length;
    if (hostPoisons > 0) {
      room.host.hp = Math.max(0, room.host.hp - hostPoisons);
      room.lastActionLog.push(`[STATUS EFFECT] Host가 독(POISON)으로 인해 HP ${hostPoisons}를 잃었습니다. (남은 HP: ${room.host.hp})`);
    }
    if (hostRegens > 0) {
      room.host.hp = Math.min(hostChar.baseHp, room.host.hp + hostRegens);
      room.lastActionLog.push(`[STATUS EFFECT] Host가 재생(REGEN)으로 인해 HP ${hostRegens}를 회복했습니다. (남은 HP: ${room.host.hp})`);
    }

    // Guest 정산
    const guestPoisons = room.statusEffects.guest.filter((eff) => eff.type === 'POISON').length;
    const guestRegens = room.statusEffects.guest.filter((eff) => eff.type === 'REGEN').length;
    if (guestPoisons > 0) {
      room.guest.hp = Math.max(0, room.guest.hp - guestPoisons);
      room.lastActionLog.push(`[STATUS EFFECT] Guest가 독(POISON)으로 인해 HP ${guestPoisons}를 잃었습니다. (남은 HP: ${room.guest.hp})`);
    }
    if (guestRegens > 0) {
      room.guest.hp = Math.min(guestChar.baseHp, room.guest.hp + guestRegens);
      room.lastActionLog.push(`[STATUS EFFECT] Guest가 재생(REGEN)으로 인해 HP ${guestRegens}를 회복했습니다. (남은 HP: ${room.guest.hp})`);
    }

    // 사망 판정
    if (room.host.hp <= 0 && room.guest.hp <= 0) {
      room.status = RoomStatus.FINISHED;
      room.winnerId = undefined;
      room.lastActionLog.push('[GAME OVER] 독 데미지로 인해 양 플레이어가 동시에 사망하여 무승부로 종료되었습니다.');
    } else if (room.host.hp <= 0) {
      room.status = RoomStatus.FINISHED;
      room.winnerId = room.guest.userId;
      room.lastActionLog.push(`[GAME OVER] 독 데미지로 인해 Host 사망. 승자: ${room.guest.nickname}`);
    } else if (room.guest.hp <= 0) {
      room.status = RoomStatus.FINISHED;
      room.winnerId = room.host.userId;
      room.lastActionLog.push(`[GAME OVER] 독 데미지로 인해 Guest 사망. 승자: ${room.host.nickname}`);
    }

    return room;
  }

  /**
   * 카드 ID 배열로부터 Card 엔티티 배열을 가져옵니다.
   */
  private async getCardsFromIds(cardIds: number[]): Promise<Card[]> {
    const cards: Card[] = [];
    for (const cid of cardIds) {
      cards.push(await this.getCardOrDefault(cid));
    }
    return cards;
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
        // MOVE 또는 ATK인 경우 valueTop 사용, DEF인 경우 valueBottom 사용
        sum += card.type === CardType.DEF ? card.valueBottom : card.valueTop;
      }
    }
    return sum;
  }

  /**
   * 캐릭터 획득 혹은 기본 캐릭터 반환 (Fallback).
   * Fallback은 DB에 없는 캐릭터 ID로 요청이 온 경우의 임시 대체값으로,
   * 실제 시드 캐릭터가 아니라 CharacterName enum에 속하지 않을 수 있어 캐스팅함.
   */
  private async getCharacterOrDefault(characterId: number): Promise<Character> {
    const character = await this.characterRepository.findOneBy({
      id: characterId,
    });
    if (character) return character;
    return {
      id: characterId,
      name: CharacterName.WARRIOR,
      baseHp: 20,
      baseAtk: 3,
      baseDef: 2,
      skills: [],
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
      valueTop: (cardId % 4) + 1,
      valueBottom: (cardId % 3) + 1,
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
    if (room.winnerId) {
      if (room.winnerId === host.id) {
        host.wins++;
        guest.losses++;
      } else if (room.winnerId === guest.id) {
        guest.wins++;
        host.losses++;
      }
    }

    host.status = UserStatus.ONLINE;
    guest.status = UserStatus.ONLINE;

    await this.userRepository.save(host);
    await this.userRepository.save(guest);

    // 역사 저장
    const history = this.matchHistoryRepository.create({
      hostUser: host,
      guestUser: guest,
      winner:
        room.winnerId === host.id
          ? host
          : room.winnerId === guest.id
            ? guest
            : null,
      turnsPlayed: room.currentTurn,
      matchData: {
        winnerId: room.winnerId,
        finalHostHp: room.host.hp,
        finalGuestHp: room.guest!.hp,
        actionLogs: room.lastActionLog || [],
      },
    });

    await this.matchHistoryRepository.save(history);

    // Redis 룸 정보 삭제
    const roomKey = `game:room:${room.id}`;
    await this.redisService.getClient().del(roomKey);
  }

}
