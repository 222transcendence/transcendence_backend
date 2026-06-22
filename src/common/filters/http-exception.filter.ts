import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    let message = exception.message;
    let errorCode = 'E_UNKNOWN';

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const resObj = exceptionResponse as any;
      if (Array.isArray(resObj.message)) {
        message = resObj.message.join(', ');
      } else if (resObj.message) {
        message = resObj.message;
      }
      if (resObj.code) {
        errorCode = resObj.code;
      } else {
        errorCode = resObj.error || 'E_ERROR';
      }
    }

    // Custom Error Code Mapping matching API_SPECIFICATION.md
    if (status === 401) {
      errorCode = 'E1001';
    } else if (status === 409) {
      errorCode = 'E_CONFLICT';
    } else if (status === 400) {
      if (message.toLowerCase().includes('queue')) {
        errorCode = 'E2001';
      } else {
        errorCode = 'E_BAD_REQUEST';
      }
    } else if (status === 404) {
      if (message.toLowerCase().includes('deck')) {
        errorCode = 'E3001';
      } else {
        errorCode = 'E_NOT_FOUND';
      }
    }

    response.status(status).json({
      timestamp: new Date().toISOString(),
      status: status,
      data: null,
      error: {
        code: errorCode,
        message: message,
      },
    });
  }
}
