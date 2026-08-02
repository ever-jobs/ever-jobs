import { Module } from '@nestjs/common';
import { TrueMetalSupplyService } from './truemetalsupply.service';

@Module({
  providers: [TrueMetalSupplyService],
  exports: [TrueMetalSupplyService],
})
export class TrueMetalSupplyModule {}
