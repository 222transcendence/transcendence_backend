import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { httpRequestDuration } from '../../metrics/metrics.registry';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const start = Date.now();

    const record = () => {
      // request.route.path is the matched route pattern (e.g. /api/users/:id),
      // not the resolved URL — keeps label cardinality bounded.
      const route =
        (request.route as { path?: string } | undefined)?.path ?? 'unknown';
      httpRequestDuration.observe(
        {
          method: request.method,
          route,
          status_code: response.statusCode,
        },
        (Date.now() - start) / 1000,
      );
    };

    return next.handle().pipe(tap({ next: record, error: record }));
  }
}
