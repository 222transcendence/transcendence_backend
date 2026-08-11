import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UserModule } from '../user/user.module';
import { GameModule } from './game.module';
import { AcidRainGateway } from './acid-rain/acid-rain.gateway';
import { AcidRainService } from './acid-rain/acid-rain.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'secret_jwt_key',
      signOptions: { expiresIn: '15m' },
    }),
    UserModule,
    GameModule,
  ],
  providers: [AcidRainGateway, AcidRainService],
})
export class GameGatewayModule {}
