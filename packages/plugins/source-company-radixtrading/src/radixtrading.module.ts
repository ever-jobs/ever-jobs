import { Module } from '@nestjs/common';
import { RadixTradingService } from './radixtrading.service';

@Module({ providers: [RadixTradingService], exports: [RadixTradingService] })
export class RadixTradingModule {}
