import { GameRoom, GamePhase, RoomStatus, DiceDetail } from './game.interface';

/**
 * 33.3% 확률의 주사위를 굴려 앞면(성공) 상세 내역 및 횟수를 반환합니다.
 * random(1, 3) === 1 조건 충족 시 성공.
 */
export function rollDiceDetail(
  count: number,
  mockRandom?: () => number,
): DiceDetail {
  const rand = mockRandom || Math.random;
  const details: boolean[] = [];
  let successes = 0;
  for (let i = 0; i < count; i++) {
    // 0 ~ 1 난수가 1/3 미만일 확률은 약 33.3%
    const isSuccess = rand() < 1 / 3;
    details.push(isSuccess);
    if (isSuccess) {
      successes++;
    }
  }
  return { count, successes, details };
}

/**
 * 33.3% 확률의 주사위를 굴려 앞면(성공) 횟수를 반환합니다.
 */
export function rollDice(count: number, mockRandom?: () => number): number {
  return rollDiceDetail(count, mockRandom).successes;
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
  mockRandom?: () => number,
): GameRoom {
  if (!room.guest) return room;

  // 거리 계산 (이동값의 차이만큼 기본 거리에서 가감, 최소 1 최대 5)
  const moveDiff = hostMoveValue - guestMoveValue;
  room.distance = Math.max(1, Math.min(5, room.distance + moveDiff));

  // 선공 결정 (이동 수치가 큰 쪽이 선공, 같으면 50% 확률)
  const rand = mockRandom || Math.random;
  let initiative: 'host' | 'guest';
  let reason = '';

  if (hostMoveValue > guestMoveValue) {
    initiative = 'host';
    reason = `Host의 이동 포인트가 더 높습니다 (${hostMoveValue} vs ${guestMoveValue})`;
  } else if (guestMoveValue > hostMoveValue) {
    initiative = 'guest';
    reason = `Guest의 이동 포인트가 더 높습니다 (${guestMoveValue} vs ${hostMoveValue})`;
  } else {
    const isHostInit = rand() < 0.5;
    initiative = isHostInit ? 'host' : 'guest';
    reason = `이동 포인트가 동일하여 50% 확률로 결정되었습니다 (${hostMoveValue} vs ${guestMoveValue})`;
  }

  room.initiative = initiative;

  // 로그 남기기
  const logMsg = `[MOVE] 선공권: ${initiative === 'host' ? room.host.nickname : room.guest.nickname} (${reason})`;
  room.lastActionLog = room.lastActionLog || [];
  room.lastActionLog.push(logMsg);

  // 페이즈 전이
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
  mockRandom?: () => number,
): GameRoom {
  if (!room.guest) return room;

  // 1. 공격 및 방어 주사위 상세 롤 수행
  const hostAtkRoll = rollDiceDetail(hostAtkVal, mockRandom);
  const guestAtkRoll = rollDiceDetail(guestAtkVal, mockRandom);
  const hostDefRoll = rollDiceDetail(hostDefVal, mockRandom);
  const guestDefRoll = rollDiceDetail(guestDefVal, mockRandom);

  // 2. 주사위 결과 저장 (브로드캐스트용)
  room.lastDiceRoll = {
    hostAtk: hostAtkRoll,
    guestAtk: guestAtkRoll,
    hostDef: hostDefRoll,
    guestDef: guestDefRoll,
  };

  // 3. 데미지 계산
  const damageToGuest = Math.max(0, hostAtkRoll.successes - guestDefRoll.successes);
  const damageToHost = Math.max(0, guestAtkRoll.successes - hostDefRoll.successes);

  // 4. 체력 적용
  room.host.hp = Math.max(0, room.host.hp - damageToHost);
  room.guest.hp = Math.max(0, room.guest.hp - damageToGuest);

  room.lastActionLog = room.lastActionLog || [];
  room.lastActionLog.push(
    `[RESULT] Host가 Guest에게 ${damageToGuest} 데미지를 주었습니다. (공격성공 ${hostAtkRoll.successes} - 방어성공 ${guestDefRoll.successes})`,
  );
  room.lastActionLog.push(
    `[RESULT] Guest가 Host에게 ${damageToHost} 데미지를 주었습니다. (공격성공 ${guestAtkRoll.successes} - 방어성공 ${hostDefRoll.successes})`,
  );

  // 5. 게임 종료 판정
  if (room.host.hp <= 0 && room.guest.hp <= 0) {
    // 동시 사망 시, 남은 HP가 더 많은 쪽이 이김. (모두 0 이하이므로 음수가 될 수 있음, 여기서는 0으로 제한되어 있음)
    // 원래 HP에서 뺀 결과가 더 큰 쪽이 이기게 판정하거나, 같으면 무승부
    room.status = RoomStatus.FINISHED;
    room.winnerId = undefined; // 무승부
    room.lastActionLog.push('[GAME OVER] 양 플레이어가 동시에 사망하여 무승부로 종료되었습니다.');
  } else if (room.host.hp <= 0) {
    room.status = RoomStatus.FINISHED;
    room.winnerId = room.guest.userId;
    room.lastActionLog.push(`[GAME OVER] Host 사망. 승자: ${room.guest.nickname}`);
  } else if (room.guest.hp <= 0) {
    room.status = RoomStatus.FINISHED;
    room.winnerId = room.host.userId;
    room.lastActionLog.push(`[GAME OVER] Guest 사망. 승자: ${room.host.nickname}`);
  } else if (room.currentTurn >= 15) {
    // 최대 15턴 초과 시 판정승
    room.status = RoomStatus.FINISHED;
    if (room.host.hp > room.guest.hp) {
      room.winnerId = room.host.userId;
      room.lastActionLog.push(`[GAME OVER] 15턴 초과. HP 판정승. 승자: ${room.host.nickname}`);
    } else if (room.guest.hp > room.host.hp) {
      room.winnerId = room.guest.userId;
      room.lastActionLog.push(`[GAME OVER] 15턴 초과. HP 판정승. 승자: ${room.guest.nickname}`);
    } else {
      room.winnerId = undefined; // 무승부
      room.lastActionLog.push('[GAME OVER] 15턴 초과. HP가 동일하여 무승부로 종료되었습니다.');
    }
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

