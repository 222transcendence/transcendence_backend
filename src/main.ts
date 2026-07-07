import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpMetricsInterceptor } from './common/interceptors/http-metrics.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LobbyGateway } from './lobby/lobby.gateway';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  app.useGlobalInterceptors(
    new HttpMetricsInterceptor(),
    new TransformInterceptor(),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  await app.listen(process.env.PORT ?? 3000);

  const httpServer = app.getHttpServer() as import('http').Server;
  const lobbyGateway = app.get(LobbyGateway);
  httpServer.on('upgrade', (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    lobbyGateway.handleUpgrade(req, socket, head);
  });
}
bootstrap();
