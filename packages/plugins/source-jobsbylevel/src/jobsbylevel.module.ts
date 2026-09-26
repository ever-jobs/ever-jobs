import { Module } from '@nestjs/common';
import { JobsByLevelService } from './jobsbylevel.service';

@Module({
  providers: [JobsByLevelService],
  exports: [JobsByLevelService],
})
export class JobsByLevelModule {}
