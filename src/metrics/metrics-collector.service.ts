import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../user/entities/user.entity';
import { registeredUsers } from './metrics.registry';

const COLLECT_INTERVAL_MS = 60_000;

@Injectable()
export class MetricsCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsCollectorService.name);
  private interval?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  onModuleInit() {
    this.collect();
    this.interval = setInterval(() => this.collect(), COLLECT_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  private async collect() {
    try {
      registeredUsers.set(await this.userRepository.count());
    } catch (error) {
      this.logger.warn(`Failed to collect registered_users metric: ${error}`);
    }
  }
}
