import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WordDictionary } from './entities/word-dictionary.entity';
import { WordDictionaryService } from './word-dictionary.service';

@Module({
  imports: [TypeOrmModule.forFeature([WordDictionary])],
  providers: [WordDictionaryService],
  exports: [WordDictionaryService],
})
export class WordDictionaryModule {}
