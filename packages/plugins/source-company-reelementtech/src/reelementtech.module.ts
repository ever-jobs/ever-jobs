import { Module } from '@nestjs/common';
import { ReelementtechService } from './reelementtech.service';

@Module({
  providers: [ReelementtechService],
  exports: [ReelementtechService],
})
export class ReelementtechModule {}
