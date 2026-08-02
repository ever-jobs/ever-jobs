import { Module } from '@nestjs/common';
import { Submit4jobsService } from './submit4jobs.service';

@Module({
  providers: [Submit4jobsService],
  exports: [Submit4jobsService],
})
export class Submit4jobsModule {}
