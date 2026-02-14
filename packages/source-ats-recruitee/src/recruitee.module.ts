import { Module } from '@nestjs/common';
import { RecruiteeService } from './recruitee.service';

@Module({
  providers: [RecruiteeService],
  exports: [RecruiteeService],
})
export class RecruiteeModule {}
