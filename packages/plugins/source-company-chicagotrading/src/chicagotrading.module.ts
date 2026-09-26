import { Module } from '@nestjs/common';
import { ChicagoTradingService } from './chicagotrading.service';

@Module({ providers: [ChicagoTradingService], exports: [ChicagoTradingService] })
export class ChicagoTradingModule {}
