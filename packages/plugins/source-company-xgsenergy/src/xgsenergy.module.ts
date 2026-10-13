import { Module } from '@nestjs/common';
import { XgsEnergyService } from './xgsenergy.service';

@Module({
  providers: [XgsEnergyService],
  exports: [XgsEnergyService],
})
export class XgsEnergyModule {}
