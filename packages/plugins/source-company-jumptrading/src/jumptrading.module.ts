import { Module } from '@nestjs/common';
import { JumpTradingService } from './jumptrading.service';

@Module({ providers: [JumpTradingService], exports: [JumpTradingService] })
export class JumpTradingModule {}
