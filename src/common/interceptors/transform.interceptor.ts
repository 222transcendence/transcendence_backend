import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ResponseEnvelope<T> {
  timestamp: string;
  status: number;
  data: T;
  error: any;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ResponseEnvelope<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ResponseEnvelope<T>> {
    const response = context.switchToHttp().getResponse();
    return next.handle().pipe(
      map((data) => {
        if (
          data &&
          typeof data === 'object' &&
          'timestamp' in data &&
          'status' in data &&
          'data' in data
        ) {
          return data;
        }
        return {
          timestamp: new Date().toISOString(),
          status: response.statusCode || 200,
          data: data !== undefined ? data : null,
          error: null,
        };
      }),
    );
  }
}
