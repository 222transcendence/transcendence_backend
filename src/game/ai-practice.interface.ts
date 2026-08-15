import type {
  AiDifficulty,
  ParticipantPublic,
} from './acid-rain/acid-rain.interface';

export const AI_PRACTICE_MODE = 'AI_PRACTICE' as const;

export type AiPracticeMode = typeof AI_PRACTICE_MODE;

export type AiPracticeLifecycleStatus = 'CREATED' | 'CANCELLED' | 'EXPIRED';

export type AiPracticeRejectCode =
  | 'INVALID_PAYLOAD'
  | 'INVALID_DIFFICULTY'
  | 'UNAUTHORIZED'
  | 'ACTIVE_PVP_ROOM_EXISTS'
  | 'ACTIVE_AI_PRACTICE_EXISTS'
  | 'DUPLICATE_REQUEST_CONFLICT'
  | 'AI_PRACTICE_NOT_FOUND'
  | 'CLEANUP_FAILED'
  | 'CREATE_FAILED';

export interface AiPracticeSession {
  mode: AiPracticeMode;
  roomId: string;
  ownerUserId: string;
  difficulty: AiDifficulty;
  participants: ParticipantPublic[];
  status: AiPracticeLifecycleStatus;
  createdAt: string;
  expiresAt: string;
}

export interface CreateAiPracticeInput {
  ownerUserId: string;
  ownerNickname: string;
  ownerAvatar?: string;
  requestId: string;
  difficulty: AiDifficulty;
}

export interface AiPracticeCreatedPayload {
  roomId: string;
  mode: AiPracticeMode;
  difficulty: AiDifficulty;
  participants: ParticipantPublic[];
  expiresAt: string;
}

export interface AiPracticeRejectedPayload {
  code: AiPracticeRejectCode;
  message: string;
}

export interface AiPracticeCancelledPayload {
  roomId: string;
}

export interface AiPracticeIdempotencyRecord {
  requestId: string;
  ownerUserId: string;
  difficulty: AiDifficulty;
  result: AiPracticeCreatedPayload;
  createdAt: string;
  expiresAt: string;
}
