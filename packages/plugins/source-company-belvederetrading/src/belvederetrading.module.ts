import { Module } from '@nestjs/common';
import { BelvedereTradingService } from './belvederetrading.service';

@Module({ providers: [BelvedereTradingService], exports: [BelvedereTradingService] })
export class BelvedereTradingModule {}
