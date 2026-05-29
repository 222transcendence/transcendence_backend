import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Client } from 'pg';
import Redis from 'ioredis';

@Controller('api/health')
export class HealthController {
  @Get()
  async getHealth(@Res() res: Response) {
    let dbStatus = 'down';
    let redisStatus = 'down';

    // 1. Test PostgreSQL connection
    const pgClient = new Client({
      connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@db:5432/transcendence',
    });
    try {
      await pgClient.connect();
      const dbRes = await pgClient.query('SELECT 1');
      if (dbRes.rows.length > 0) {
        dbStatus = 'ok';
      }
      await pgClient.end();
    } catch (err) {
      console.error('Database connection error:', err);
    }

    // 2. Test Redis connection
    try {
      const redisClient = new Redis(process.env.REDIS_URL || 'redis://redis:6379');
      const pong = await redisClient.ping();
      if (pong === 'PONG') {
        redisStatus = 'ok';
      }
      await redisClient.quit();
    } catch (err) {
      console.error('Redis connection error:', err);
    }

    const isHealthy = dbStatus === 'ok' && redisStatus === 'ok';
    return res.status(isHealthy ? 200 : 500).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      database: dbStatus,
      redis: redisStatus,
    });
  }
}
