import { handleMovePhase, handleResultPhase, rollDice, rollDiceDetail } from './game-engine';
import { GameRoom, GamePhase, RoomStatus } from './game.interface';

describe('GameEngine', () => {
  describe('rollDice / rollDiceDetail (33.3% Rule)', () => {
    it('should output successes in a 33.3% probability range statistically over 10000 trials', () => {
      const trials = 10000;
      let totalSuccesses = 0;
      
      for (let i = 0; i < trials; i++) {
        totalSuccesses += rollDice(1);
      }
      
      const successRate = totalSuccesses / trials;
      // 33.3% +- 2% 오차 범위 내 검증
      expect(successRate).toBeGreaterThanOrEqual(0.31);
      expect(successRate).toBeLessThanOrEqual(0.35);
    });

    it('should correctly build DiceDetail structure', () => {
      const detail = rollDiceDetail(3, () => 0.1); // 0.1 < 1/3 이므로 모두 성공
      expect(detail.count).toBe(3);
      expect(detail.successes).toBe(3);
      expect(detail.details).toEqual([true, true, true]);
    });
  });

  describe('handleMovePhase (Initiative & Distance)', () => {
    let mockRoom: GameRoom;

    beforeEach(() => {
      mockRoom = {
        id: 'room-test',
        status: RoomStatus.IN_GAME,
        host: {
          userId: 'host-1',
          nickname: 'HostUser',
          characterId: 1,
          hp: 20,
          cardsInHand: [],
          cardsSubmitted: [],
        },
        guest: {
          userId: 'guest-1',
          nickname: 'GuestUser',
          characterId: 2,
          hp: 20,
          cardsInHand: [],
          cardsSubmitted: [],
        },
        phase: GamePhase.MOVE,
        distance: 3,
        currentTurn: 1,
        statusEffects: { host: [], guest: [] },
      };
    });

    it('should award initiative to host if host moves more', () => {
      const nextRoom = handleMovePhase(mockRoom, 5, 2);
      expect(nextRoom.initiative).toBe('host');
      expect(nextRoom.distance).toBe(5); // 3 + (5-2) = 6이나 max 5
      expect(nextRoom.phase).toBe(GamePhase.ATTACK);
    });

    it('should award initiative to guest if guest moves more', () => {
      const nextRoom = handleMovePhase(mockRoom, 1, 4);
      expect(nextRoom.initiative).toBe('guest');
      expect(nextRoom.distance).toBe(1); // 3 + (1-4) = 0이나 min 1
    });

    it('should resolve draw initiative with 50% probability', () => {
      // mock random to force guest
      const nextRoom = handleMovePhase(mockRoom, 3, 3, () => 0.8); // > 0.5 이므로 guest
      expect(nextRoom.initiative).toBe('guest');
    });
  });

  describe('handleResultPhase (Damage and GameOver)', () => {
    let mockRoom: GameRoom;

    beforeEach(() => {
      mockRoom = {
        id: 'room-test',
        status: RoomStatus.IN_GAME,
        host: {
          userId: 'host-1',
          nickname: 'HostUser',
          characterId: 1,
          hp: 10,
          cardsInHand: [],
          cardsSubmitted: [],
        },
        guest: {
          userId: 'guest-1',
          nickname: 'GuestUser',
          characterId: 2,
          hp: 10,
          cardsInHand: [],
          cardsSubmitted: [],
        },
        phase: GamePhase.DEFENSE,
        distance: 3,
        currentTurn: 1,
        statusEffects: { host: [], guest: [] },
      };
    });

    it('should apply damage and transition to DRAW phase if alive', () => {
      // mock random to force hits: 0.1 < 1/3 (hit)
      // hostAtkVal = 3 => successes = 3
      // guestDefVal = 2 => successes = 2
      // damage to guest = 3 - 2 = 1 => hp: 10 -> 9
      // guestAtkVal = 2 => successes = 2
      // hostDefVal = 2 => successes = 2
      // damage to host = 2 - 2 = 0 => hp: 10 -> 10
      const nextRoom = handleResultPhase(mockRoom, 3, 2, 2, 2, () => 0.1);
      expect(nextRoom.host.hp).toBe(10);
      expect(nextRoom.guest!.hp).toBe(9);
    });

    it('should declare finished status with winner guest if host hp <= 0', () => {
      mockRoom.host.hp = 1;
      mockRoom.guest!.hp = 10;
      const nextRoom = handleResultPhase(mockRoom, 0, 0, 5, 0, () => 0.1);
      expect(nextRoom.status).toBe(RoomStatus.FINISHED);
      expect(nextRoom.winnerId).toBe('guest-1');
    });

    it('should declare finished status with tie if turn limit 15 exceeded', () => {
      mockRoom.currentTurn = 15;
      const nextRoom = handleResultPhase(mockRoom, 0, 0, 0, 0, () => 0.1);
      expect(nextRoom.status).toBe(RoomStatus.FINISHED);
      expect(nextRoom.winnerId).toBeUndefined(); // HP 동일하므로 무승부
    });
  });
});
