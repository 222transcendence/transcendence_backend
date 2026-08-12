import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KeystrokeRecord } from '../entities/keystroke-record.entity';
import { WordAttemptRecord, WordAttemptResult } from '../entities/word-attempt-record.entity';
import { ParticipantPerformance } from '../entities/participant-performance.entity';
import type { AcidRainSession, WordTypingState } from './acid-rain.interface';

interface WordResolveInput {
  matchId: string;
  participantId: string;
  userId?: string;
  wordId: string;
  result: WordAttemptResult;
  submittedText: string | null;
  submitReceivedAt: Date | null;
  resolvedAt: Date;
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
        result: input.result,
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
          state.keystrokeBuffer.map(k =>
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
      const wordAttempts = await this.wordAttemptRepo.find({ where: { matchId } });

      for (const participant of session.participants) {
        const pAttempts = wordAttempts.filter(
          a => a.participantId === participant.participantId,
        );

        const correctWords = pAttempts.filter(
          a => a.result === 'CORRECT' || a.result === 'CORRECT_AFTER_CORRECTION',
        ).length;
        const wrongAttempts = pAttempts.filter(a => a.result === 'WRONG').length;
        const missedWords = pAttempts.filter(a => a.result === 'MISSED').length;
        const abandonedWords = pAttempts.filter(a => a.result === 'GIVE_UP').length;
        const typoCount = pAttempts.reduce((s, a) => s + a.typoCount, 0);
        const correctionCount = pAttempts.reduce((s, a) => s + a.correctionCount, 0);
        const totalKeystrokes = pAttempts.reduce((s, a) => s + a.totalKeystrokes, 0);

        const totalAttempts = correctWords + wrongAttempts;
        const accuracy = totalAttempts > 0 ? correctWords / totalAttempts : null;

        const reactionTimes = pAttempts
          .filter(a => a.firstTypingAt && a.resolvedAt)
          .map(a => a.firstTypingAt!.getTime() - (a.resolvedAt.getTime() - (a.submitReceivedAt?.getTime() ?? a.resolvedAt.getTime())))
          .filter(t => t > 0);

        const wordSpawnTimes: number[] = [];
        const completionTimes = pAttempts
          .filter(a => a.firstTypingAt && a.submitReceivedAt)
          .map(a => a.submitReceivedAt!.getTime() - a.firstTypingAt!.getTime())
          .filter(t => t > 0);

        const avgReactionTimeMs = reactionTimes.length > 0
          ? reactionTimes.reduce((s, t) => s + t, 0) / reactionTimes.length
          : null;
        const medianReactionTimeMs = reactionTimes.length > 0
          ? median(reactionTimes)
          : null;
        const avgCompletionTimeMs = completionTimes.length > 0
          ? completionTimes.reduce((s, t) => s + t, 0) / completionTimes.length
          : null;

        const durationSec = session.status === 'FINISHED'
          ? Math.round((Date.now() - session.startedAt) / 1000)
          : null;
        const typingWpm = durationSec && durationSec > 0 && correctWords > 0
          ? (correctWords / durationSec) * 60
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
            accuracy,
            avgReactionTimeMs,
            medianReactionTimeMs,
            avgCompletionTimeMs,
            sampleCount: correctWords + wrongAttempts,
            typingDurationMs: durationSec ? durationSec * 1000 : null,
          }),
        );
      }
    } catch (err) {
      this.logger.error(`saveParticipantPerformances failed: ${String(err)}`);
    }
  }
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
