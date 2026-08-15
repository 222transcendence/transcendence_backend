import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../user/entities/user.entity';
import { MetricsController } from './metrics.controller';
import { MetricsCollectorService } from './metrics-collector.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [MetricsController],
  providers: [MetricsCollectorService],
})
export class MetricsModule {}
