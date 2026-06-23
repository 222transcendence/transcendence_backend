import { GameRoom, GamePhase, RoomStatus } from './game.interface';

/**
 * 33.3% 확률의 주사위를 굴려 앞면(성공) 횟수를 반환합니다.
 * random(1, 3) === 1 조건 충족 시 성공.
 */
export function rollDice(count: number, mockRandom?: () => number): number {
  let success = 0;
  const rand = mockRandom || Math.random;
  for (let i = 0; i < count; i++) {
    // 0 ~ 1 난수가 1/3 미만일 확률은 약 33.3%
    if (rand() < 1 / 3) {
      success++;
    }
  }
  return success;
}

/**
 * 각 플레이어에게 카드를 최대 5장까지 채워 지급합니다.
 */
export function handleDrawPhase(
  room: GameRoom,
  hostCards: number[],
  guestCards: number[],
): GameRoom {
  if (!room.guest) return room;

  // 카드 보충
  room.host.cardsInHand.push(...hostCards);
  room.guest.cardsInHand.push(...guestCards);

  // 페이즈 전이
  room.phase = GamePhase.MOVE;
  return room;
}

/**
 * MOVE 페이즈 제출 처리.
 * 이동 수치 계산 및 선공권 결정.
 */
export function handleMovePhase(
  room: GameRoom,
  hostMoveValue: number,
  guestMoveValue: number,
): GameRoom {
  if (!room.guest) return room;

  // 거리 계산 (이동값의 차이만큼 기본 거리에서 가감, 최소 1 최대 5)
  // 예시 규칙: distance = Math.max(1, Math.min(5, room.distance + (hostMoveValue - guestMoveValue)));
  // 단순화를 위해 hostMoveValue와 guestMoveValue 차이만큼 가감
  const moveDiff = hostMoveValue - guestMoveValue;
  room.distance = Math.max(1, Math.min(5, room.distance + moveDiff));

  // 선공 결정 (이동 수치가 큰 쪽이 선공)
  // 임시로, host가 크면 host 선공, guest가 크면 guest 선공, 같으면 random.
  // 이 결과에 대한 명시는 Websocket 및 Action Log에 기록됨.
  // 여기서는 다음 페이즈인 ATTACK으로 바로 이동.
  room.phase = GamePhase.ATTACK;

  // 카드 제출 리셋
  room.host.cardsSubmitted = [];
  room.guest.cardsSubmitted = [];

  return room;
}

/**
 * RESULT 페이즈 연산.
 * 공격력 및 방어력의 주사위 롤을 수행하고 최종 HP를 차감합니다.
 */
export function handleResultPhase(
  room: GameRoom,
  hostAtkVal: number,
  hostDefVal: number,
  guestAtkVal: number,
  guestDefVal: number,
  diceRollFn: (count: number) => number,
): GameRoom {
  if (!room.guest) return room;

  // 1. 공격 주사위 롤
  const hostAtkSuccess = diceRollFn(hostAtkVal);
  const guestAtkSuccess = diceRollFn(guestAtkVal);

  // 2. 방어 주사위 롤
  const hostDefSuccess = diceRollFn(hostDefVal);
  const guestDefSuccess = diceRollFn(guestDefVal);

  // 3. 데미지 계산
  const damageToGuest = Math.max(0, hostAtkSuccess - guestDefSuccess);
  const damageToHost = Math.max(0, guestAtkSuccess - hostDefSuccess);

  // 4. 체력 적용
  room.host.hp = Math.max(0, room.host.hp - damageToHost);
  room.guest.hp = Math.max(0, room.guest.hp - damageToGuest);

  // 5. 게임 종료 판정
  if (room.host.hp <= 0 && room.guest.hp <= 0) {
    // 동시 사망 시, 남은 HP가 더 적은 쪽이 패배, 같으면 Host가 이기게 설정(또는 무승부)
    room.status = RoomStatus.FINISHED;
    room.winnerId = room.host.userId; // 임시 처리
  } else if (room.host.hp <= 0) {
    room.status = RoomStatus.FINISHED;
    room.winnerId = room.guest.userId;
  } else if (room.guest.hp <= 0) {
    room.status = RoomStatus.FINISHED;
    room.winnerId = room.host.userId;
  } else {
    // 계속 진행 -> DRAW 페이즈로 전환하고 턴 증가
    room.phase = GamePhase.DRAW;
    room.currentTurn++;
  }

  // 카드 제출 리셋
  room.host.cardsSubmitted = [];
  room.guest.cardsSubmitted = [];

  return room;
}
