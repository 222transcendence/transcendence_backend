import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  WordDictionary,
  WordLanguage,
  WordDifficulty,
  WordContentType,
  WordCategory,
} from './entities/word-dictionary.entity';
import { SEED_WORDS } from './seed-words';

export interface WordEntry {
  text: string;
  keystrokes: number;
}

const LOW_MAX_KEYSTROKES = 5;
const MID_MAX_KEYSTROKES = 9;

@Injectable()
export class WordDictionaryService implements OnModuleInit {
  private readonly logger = new Logger(WordDictionaryService.name);

  private lowPool: WordEntry[] = [];
  private midPool: WordEntry[] = [];
  private highPool: WordEntry[] = [];
  private lowMidPool: WordEntry[] = [];

  constructor(
    @InjectRepository(WordDictionary)
    private readonly repo: Repository<WordDictionary>,
  ) {}

  async onModuleInit() {
    await this.autoSeedIfEmpty();
    await this.reloadPools();
  }

  private async autoSeedIfEmpty(): Promise<void> {
    const count = await this.repo.count({ where: { isActive: true } });
    if (count > 0) return;

    this.logger.log('Word dictionary is empty — running initial seed');
    const unique = new Map<string, (typeof SEED_WORDS)[number]>();
    for (const w of SEED_WORDS) {
      if (!unique.has(w.text)) unique.set(w.text, w);
    }

    let inserted = 0;
    for (const [, entry] of unique) {
      const ks = entry.keystrokes;
      const difficulty =
        ks <= 5 ? WordDifficulty.EASY : ks <= 9 ? WordDifficulty.NORMAL : WordDifficulty.HARD;
      await this.repo.save(
        this.repo.create({
          text: entry.text,
          keystrokes: ks,
          difficulty,
          language: WordLanguage.KO,
          contentType: WordContentType.WORD,
          category: WordCategory.COMMON,
          length: [...entry.text].length,
          source: 'word-bank-v1',
          isActive: true,
        }),
      );
      inserted++;
    }
    this.logger.log(`Auto-seed complete: ${inserted} words inserted`);
  }

  /** 필터 조건 없이 전체 활성 단어를 메모리 풀로 로드. */
  async reloadPools(
    language: WordLanguage = WordLanguage.KO,
    contentType: WordContentType = WordContentType.WORD,
  ): Promise<void> {
    const words = await this.repo.find({
      where: { language, contentType, isActive: true },
      select: { text: true, keystrokes: true },
    });

    if (words.length === 0) {
      this.logger.warn('WordDictionary pool is empty — game will use empty word list');
    }

    this.lowPool = words.filter((w) => w.keystrokes <= LOW_MAX_KEYSTROKES);
    this.midPool = words.filter(
      (w) => w.keystrokes > LOW_MAX_KEYSTROKES && w.keystrokes <= MID_MAX_KEYSTROKES,
    );
    this.highPool = words.filter((w) => w.keystrokes > MID_MAX_KEYSTROKES);
    this.lowMidPool = [...this.lowPool, ...this.midPool];

    this.logger.log(
      `Word pools loaded — low:${this.lowPool.length} mid:${this.midPool.length} high:${this.highPool.length}`,
    );
  }

  /**
   * 경과 시간 기반 난이도 가중치로 단어 선택 (GAME_DESIGN.md §3.4, #100에서 페이스를
   * 앞당김 — 예전엔 90초가 지나야 HIGH가 25% 확률로만 나와서, 180초 매치 절반이
   * 지나야 어려운 단어를 거의 못 보는 문제가 있었다).
   * - 0~10s: LOW만
   * - 10~40s: LOW+MID 균등
   * - 40s~: LOW/MID/HIGH = 25/35/40
   */
  pickWord(elapsedSec: number): WordEntry {
    const pool = this.selectPool(elapsedSec);
    if (pool.length === 0) {
      return { text: '사과', keystrokes: 5 }; // 풀이 비었을 때 최소 fallback
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private selectPool(elapsedSec: number): WordEntry[] {
    if (elapsedSec < 10) return this.lowPool;
    if (elapsedSec < 40) return this.lowMidPool;

    const roll = Math.random();
    if (roll < 0.25) return this.lowPool;
    if (roll < 0.6) return this.midPool;
    return this.highPool;
  }

  // ─── 관리용 ──────────────────────────────────────────────────────────────

  async getPoolStats() {
    return {
      low: this.lowPool.length,
      mid: this.midPool.length,
      high: this.highPool.length,
    };
  }

  async upsertWords(
    entries: { text: string; keystrokes: number; difficulty: WordDifficulty; language?: WordLanguage }[],
  ): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const entry of entries) {
      const existing = await this.repo.findOneBy({ text: entry.text });
      if (existing) { skipped++; continue; }
      await this.repo.save(
        this.repo.create({
          text: entry.text,
          keystrokes: entry.keystrokes,
          difficulty: entry.difficulty,
          language: entry.language ?? WordLanguage.KO,
          length: [...entry.text].length,
        }),
      );
      inserted++;
    }
    return { inserted, skipped };
  }
}
