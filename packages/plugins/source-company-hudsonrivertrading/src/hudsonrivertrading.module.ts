import { Module } from '@nestjs/common';
import { HudsonRiverTradingService } from './hudsonrivertrading.service';

@Module({ providers: [HudsonRiverTradingService], exports: [HudsonRiverTradingService] })
export class HudsonRiverTradingModule {}
