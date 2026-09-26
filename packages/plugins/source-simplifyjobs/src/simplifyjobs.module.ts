import { Module } from '@nestjs/common';
import { SimplifyJobsService } from './simplifyjobs.service';

@Module({
  providers: [SimplifyJobsService],
  exports: [SimplifyJobsService],
})
export class SimplifyJobsModule {}
