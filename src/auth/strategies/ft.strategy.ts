import { Injectable, Type } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import Strategy from 'passport-42';
import { AuthService } from '../auth.service';

@Injectable()
export class FtStrategy extends (PassportStrategy(Strategy, '42') as Type<any>) {
  constructor(private readonly authService: AuthService) {
    super({
      clientID: process.env.FT_CLIENT_ID || 'dummy_client_id',
      clientSecret: process.env.FT_CLIENT_SECRET || 'dummy_client_secret',
      callbackURL: process.env.FT_CALLBACK_URL || 'http://localhost:3000/api/auth/42/callback',
    } as any);
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: any,
  ): Promise<any> {
    const { username, emails, _json } = profile;
    const email =
      emails && emails[0]
        ? emails[0].value
        : `${username}@student.42gyeongsan.kr`;
    const avatar = _json?.image?.link || 'default_avatar.png';

    return this.authService.validateOrCreateFtUser({ email, username, avatar });
  }
}
