import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UserService } from '../user/user.service';
import { SignupDto } from './dto/signup.dto';
import * as bcrypt from 'bcrypt';
import { User, UserStatus } from '../user/entities/user.entity';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
  ) {}

  async signup(signupDto: SignupDto): Promise<User> {
    const { email, nickname, password } = signupDto;

    const existingByEmail = await this.userService.findByEmail(email);
    if (existingByEmail) {
      throw new ConflictException('Email already exists');
    }

    const existingByNickname = await this.userService.findByNickname(nickname);
    if (existingByNickname) {
      throw new ConflictException('Nickname already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await this.userService.create({
      email,
      nickname,
      password: hashedPassword,
    });

    delete user.password;
    return user;
  }

  async validateUser(email: string, pass: string): Promise<any> {
    const user = await this.userService.findByEmail(email);
    if (user && user.password && (await bcrypt.compare(pass, user.password))) {
      const { password, ...result } = user;
      return result;
    }
    return null;
  }

  async login(user: any) {
    const payload = { email: user.email, sub: user.id };

    const accessToken = this.jwtService.sign(payload, { expiresIn: '15m' });
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });

    // Store Refresh Token in Redis (TTL: 7 days = 604800 seconds)
    await this.redisService.set(`refresh_token:${user.id}`, refreshToken, 604800);

    // Update status to ONLINE
    await this.userService.update(user.id, { status: UserStatus.ONLINE });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        avatar: user.avatar,
        status: UserStatus.ONLINE,
      },
    };
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken);
      const userId = payload.sub;

      const savedToken = await this.redisService.get(`refresh_token:${userId}`);
      if (!savedToken || savedToken !== refreshToken) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const newPayload = { email: payload.email, sub: userId };
      const accessToken = this.jwtService.sign(newPayload, { expiresIn: '15m' });

      return { accessToken };
    } catch (e) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string) {
    await this.redisService.del(`refresh_token:${userId}`);
    await this.userService.update(userId, { status: UserStatus.OFFLINE });
  }

  async validateOrCreateFtUser(ftUser: {
    email: string;
    username: string;
    avatar: string;
  }): Promise<User> {
    let user = await this.userService.findByEmail(ftUser.email);
    if (!user) {
      let nickname = ftUser.username;
      const existingByNickname = await this.userService.findByNickname(nickname);
      if (existingByNickname) {
        nickname = `${ftUser.username}_${Math.floor(Math.random() * 1000)}`;
      }
      user = await this.userService.create({
        email: ftUser.email,
        nickname,
        avatar: ftUser.avatar,
      });
    }
    return user;
  }
}
