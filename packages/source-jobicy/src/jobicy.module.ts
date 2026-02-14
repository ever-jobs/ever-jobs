import { Module } from '@nestjs/common';
import { JobicyService } from './jobicy.service';

@Module({
  providers: [JobicyService],
  exports: [JobicyService],
})
export class JobicyModule {}
