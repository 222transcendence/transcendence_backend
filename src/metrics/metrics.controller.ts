import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { registry } from './metrics.registry';

@Controller()
export class MetricsController {
  @Get('metrics')
  async getMetrics(@Res() res: Response) {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }
}
