import { Module } from '@nestjs/common';
import { AmpflameService } from './ampflame.service';

@Module({
  providers: [AmpflameService],
  exports: [AmpflameService],
})
export class AmpflameModule {}
