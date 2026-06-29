import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  Get,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { FtAuthGuard } from './guards/ft-auth.guard';
import { LoginDto } from './dto/login.dto';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  async signup(@Body() signupDto: SignupDto) {
    return await this.authService.signup(signupDto);
  }

  @UseGuards(LocalAuthGuard)
  @Post('login')
  async login(@Request() req, @Body() loginDto: LoginDto) {
    return await this.authService.login(req.user);
  }

  @Post('refresh')
  async refresh(@Body('refreshToken') refreshToken: string) {
    return await this.authService.refresh(refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@Request() req) {
    const authHeader: string | undefined = req.headers?.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    await this.authService.logout(req.user.id, token);
    return { success: true };
  }

  @UseGuards(FtAuthGuard)
  @Get('42')
  async ftAuth() {
    // passport redirects to 42 authorization page
  }

  @UseGuards(FtAuthGuard)
  @Get('42/callback')
  async ftAuthCallback(@Request() req, @Res() res: Response) {
    // The browser navigates here directly (42's redirect), so the SPA can't
    // intercept this response via fetch/XHR. Hand the tokens off via a
    // redirect to a frontend route that stores them, instead of returning
    // JSON the user would see as raw text.
    const { accessToken, refreshToken } = await this.authService.login(
      req.user,
    );
    res.redirect(
      `/oauth/callback?accessToken=${accessToken}&refreshToken=${refreshToken}`,
    );
  }
}
