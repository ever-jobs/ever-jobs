import { Module } from '@nestjs/common';
import { AvalanchefusionService } from './avalanchefusion.service';

@Module({
  providers: [AvalanchefusionService],
  exports: [AvalanchefusionService],
})
export class AvalanchefusionModule {}
