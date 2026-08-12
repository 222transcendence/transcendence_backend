import type { ActiveWord } from '../acid-rain.interface';
import type { ActiveWordCandidate } from './state-evaluator';
import type { AiRuntimeWord } from './ai-execution.types';

export function toAiRuntimeWords(
  activeWords: ReadonlyMap<string, ActiveWord>,
): AiRuntimeWord[] {
  return [...activeWords.entries()]
    .filter(([wordId, word]) => wordId === word.wordId)
    .map(([, word]) => ({
      wordId: word.wordId,
      text: word.text,
      keystrokes: word.keystrokes,
      landAtMs: word.landAt,
      damage: word.damage,
    }));
}

export function toAiCandidates(
  words: readonly AiRuntimeWord[],
): ActiveWordCandidate[] {
  return words.map(({ wordId, keystrokes, landAtMs, damage }) => ({
    wordId,
    keystrokes,
    landAtMs,
    damage,
  }));
}
