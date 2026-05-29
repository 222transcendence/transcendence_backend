import { ConflictException, Injectable } from '@nestjs/common';
import { UserService } from '../user/user.service';
import { SignupDto } from './dto/signup.dto';
import * as bcrypt from 'bcrypt';
import { User } from '../user/entities/user.entity';

@Injectable()
export class AuthService {
  constructor(private readonly userService: UserService) {}

  async signup(signupDto: SignupDto): Promise<User> {
    const { email, nickname, password } = signupDto;

    // 1. Check email uniqueness
    const existingByEmail = await this.userService.findByEmail(email);
    if (existingByEmail) {
      throw new ConflictException('Email already exists');
    }

    // 2. Check nickname uniqueness
    const existingByNickname = await this.userService.findByNickname(nickname);
    if (existingByNickname) {
      throw new ConflictException('Nickname already exists');
    }

    // 3. Hash password (saltRounds: 12)
    const hashedPassword = await bcrypt.hash(password, 12);

    // 4. Save user
    const user = await this.userService.create({
      email,
      nickname,
      password: hashedPassword,
    });

    delete user.password;
    return user;
  }
}
