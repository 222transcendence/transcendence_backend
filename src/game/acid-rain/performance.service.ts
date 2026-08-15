import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KeystrokeRecord } from '../entities/keystroke-record.entity';
import {
  WordAttemptRecord,
  WordAttemptResult,
} from '../entities/word-attempt-record.entity';
import { ParticipantPerformance } from '../entities/participant-performance.entity';
import type { AcidRainSession, WordTypingState } from './acid-rain.interface';

interface WordResolveInput {
  matchId: string;
  participantId: string;
  userId?: string;
  wordId: string;
  targetKeystrokes?: number | null;
  result: WordAttemptResult;
  submittedText: string | null;
  submitReceivedAt: Date | null;
  resolvedAt: Date;
  wordSpawnedAt: Date | null;
  state: WordTypingState;
}

@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(
    @InjectRepository(KeystrokeRecord)
    private readonly keystrokeRepo: Repository<KeystrokeRecord>,
    @InjectRepository(WordAttemptRecord)
    private readonly wordAttemptRepo: Repository<WordAttemptRecord>,
    @InjectRepository(ParticipantPerformance)
    private readonly performanceRepo: Repository<ParticipantPerformance>,
  ) {}

  /** 단어 판정 완료 시 WordAttemptRecord 생성 및 KeystrokeRecord 일괄 저장 */
  async flushWordAttempt(input: WordResolveInput): Promise<void> {
    const { state } = input;
    try {
      const wordAttempt = this.wordAttemptRepo.create({
        matchId: input.matchId,
        participantId: input.participantId,
        userId: input.userId,
        wordId: input.wordId,
        targetKeystrokes: input.targetKeystrokes ?? null,
        result: input.result,
        wordSpawnedAt: input.wordSpawnedAt,
        firstTypingAt: state.firstTypingAt,
        lastTypingAt: state.lastTypingAt,
        submitReceivedAt: input.submitReceivedAt,
        resolvedAt: input.resolvedAt,
        submittedText: input.submittedText,
        typoCount: state.typoCount,
        correctionCount: state.correctionCount,
        totalKeystrokes: state.totalKeystrokes,
      });
      await this.wordAttemptRepo.save(wordAttempt);

      if (state.keystrokeBuffer.length > 0) {
        await this.keystrokeRepo.save(
          state.keystrokeBuffer.map((k) =>
            this.keystrokeRepo.create({
              matchId: input.matchId,
              participantId: input.participantId,
              userId: input.userId,
              wordId: k.wordId,
              sequence: k.sequence,
              partialText: k.partialText,
              textLength: k.textLength,
              inputType: k.inputType,
              clientTs: k.clientTs,
              serverReceivedAt: k.serverReceivedAt,
            }),
          ),
        );
      }
    } catch (err) {
      this.logger.error(`flushWordAttempt failed: ${String(err)}`);
    }
  }

  /** 매치 종료 시 참가자별 집계 저장 */
  async saveParticipantPerformances(
    session: AcidRainSession,
    matchId: string,
    resultStatus: 'FINISHED' | 'ABORTED' | 'VOID',
  ): Promise<void> {
    try {
      const wordAttempts = await this.wordAttemptRepo.find({
        where: { matchId },
      });

      for (const participant of session.participants) {
        const pAttempts = wordAttempts.filter(
          (a) => a.participantId === participant.participantId,
        );

        const correctWords = pAttempts.filter(
          (a) =>
            a.result === 'CORRECT' || a.result === 'CORRECT_AFTER_CORRECTION',
        ).length;
        const wrongAttempts = pAttempts.filter(
          (a) => a.result === 'WRONG',
        ).length;
        const missedWords = pAttempts.filter(
          (a) => a.result === 'MISSED',
        ).length;
        const abandonedWords = pAttempts.filter(
          (a) => a.result === 'GIVE_UP',
        ).length;
        const typoCount = pAttempts.reduce((s, a) => s + a.typoCount, 0);
        const correctionCount = pAttempts.reduce(
          (s, a) => s + a.correctionCount,
          0,
        );
        const totalKeystrokes = pAttempts.reduce(
          (s, a) => s + a.totalKeystrokes,
          0,
        );
        const physicalKeystrokes = totalKeystrokes + correctionCount;

        const totalAttempts = correctWords + wrongAttempts;
        const accuracy =
          totalAttempts > 0 ? correctWords / totalAttempts : null;

        const reactionTimes = pAttempts
          .filter((a) => a.firstTypingAt && a.wordSpawnedAt)
          .map((a) => a.firstTypingAt!.getTime() - a.wordSpawnedAt!.getTime())
          .filter((t) => t > 0 && t < 30_000);
        const completionTimes = pAttempts
          .filter((a) => a.firstTypingAt && a.submitReceivedAt)
          .map(
            (a) => a.submitReceivedAt!.getTime() - a.firstTypingAt!.getTime(),
          )
          .filter((t) => t > 0 && t < 30_000);

        const avgReactionTimeMs =
          reactionTimes.length > 0
            ? reactionTimes.reduce((s, t) => s + t, 0) / reactionTimes.length
            : null;
        const medianReactionTimeMs =
          reactionTimes.length > 0 ? median(reactionTimes) : null;
        const timing = deriveReactionTiming(pAttempts);
        const avgCompletionTimeMs =
          completionTimes.length > 0
            ? completionTimes.reduce((s, t) => s + t, 0) /
              completionTimes.length
            : null;

        const effectiveAttempts = pAttempts.filter(
          (a) =>
            (a.result === 'CORRECT' ||
              a.result === 'CORRECT_AFTER_CORRECTION') &&
            a.firstTypingAt &&
            a.wordSpawnedAt &&
            a.submitReceivedAt,
        );
        const effectiveDurationMs = effectiveAttempts.reduce(
          (sum, attempt) =>
            sum +
            attempt.submitReceivedAt!.getTime() -
            attempt.wordSpawnedAt!.getTime(),
          0,
        );
        const effectiveKeystrokes = effectiveAttempts.reduce(
          (sum, attempt) =>
            sum + attempt.totalKeystrokes + attempt.correctionCount,
          0,
        );

        // Measure only active word-entry time. Match duration includes spawn,
        // miss, countdown, and idle periods and substantially understates WPM.
        const activeTypingDurationMs =
          completionTimes.length > 0
            ? completionTimes.reduce((s, t) => s + t, 0)
            : null;
        const typingWpm =
          activeTypingDurationMs && physicalKeystrokes > 0
            ? (physicalKeystrokes / 5 / activeTypingDurationMs) * 60_000
            : null;
        const effectiveWordsPerMinute =
          effectiveDurationMs && effectiveKeystrokes > 0
            ? (effectiveKeystrokes / 5 / effectiveDurationMs) * 60_000
            : null;

        await this.performanceRepo.save(
          this.performanceRepo.create({
            matchId,
            participantId: participant.participantId,
            userId: participant.userId,
            participantType: participant.type,
            mode: session.mode,
            resultStatus,
            correctWords,
            wrongAttempts,
            missedWords,
            typoCount,
            correctionCount,
            abandonedWords,
            totalKeystrokes,
            typingWpm,
            effectiveWordsPerMinute,
            accuracy,
            avgReactionTimeMs,
            avgQueueTimeMs: timing.avgQueueTimeMs,
            avgAcquisitionTimeMs: timing.avgAcquisitionTimeMs,
            avgInitialReactionTimeMs: timing.avgInitialReactionTimeMs,
            medianReactionTimeMs,
            avgCompletionTimeMs,
            sampleCount: correctWords + wrongAttempts,
            typingDurationMs: activeTypingDurationMs,
          }),
        );
      }
    } catch (err) {
      this.logger.error(`saveParticipantPerformances failed: ${String(err)}`);
    }
  }
}

interface ReactionTiming {
  avgQueueTimeMs: number | null;
  avgAcquisitionTimeMs: number | null;
  avgInitialReactionTimeMs: number | null;
}

function deriveReactionTiming(
  attempts: Array<{
    wordSpawnedAt: Date | null;
    firstTypingAt: Date | null;
    submitReceivedAt: Date | null;
  }>,
): ReactionTiming {
  const orderedSubmits = attempts
    .map((attempt) => attempt.submitReceivedAt?.getTime())
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  const queueTimes: number[] = [];
  const acquisitionTimes: number[] = [];
  const initialTimes: number[] = [];

  for (const attempt of attempts) {
    if (!attempt.wordSpawnedAt || !attempt.firstTypingAt) continue;
    const spawnedAt = attempt.wordSpawnedAt.getTime();
    const firstTypingAt = attempt.firstTypingAt.getTime();
    const previousSubmit = orderedSubmits
      .filter((submitAt) => submitAt < firstTypingAt)
      .at(-1);
    const busyUntil = Math.max(spawnedAt, previousSubmit ?? spawnedAt);
    const totalReaction = firstTypingAt - spawnedAt;
    const queueTime = Math.max(0, (previousSubmit ?? spawnedAt) - spawnedAt);
    const acquisitionTime = Math.max(0, firstTypingAt - busyUntil);
    if (totalReaction < 0) continue;
    queueTimes.push(queueTime);
    acquisitionTimes.push(acquisitionTime);
    if (previousSubmit === undefined || previousSubmit <= spawnedAt) {
      initialTimes.push(acquisitionTime);
    }
  }

  return {
    avgQueueTimeMs: meanOrNull(queueTimes),
    avgAcquisitionTimeMs: meanOrNull(acquisitionTimes),
    avgInitialReactionTimeMs: meanOrNull(initialTimes),
  };
}

function meanOrNull(values: number[]): number | null {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
