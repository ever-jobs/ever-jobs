import { Module } from '@nestjs/common';
import { ZennoAstronauticsService } from './zennoastronautics.service';

@Module({
  providers: [ZennoAstronauticsService],
  exports: [ZennoAstronauticsService],
})
export class ZennoAstronauticsModule {}
