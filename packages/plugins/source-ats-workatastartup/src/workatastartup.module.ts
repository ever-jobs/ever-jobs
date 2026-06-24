import { Module } from '@nestjs/common';
import { WorkAtAStartupService } from './workatastartup.service';

@Module({
  providers: [WorkAtAStartupService],
  exports: [WorkAtAStartupService],
})
export class WorkAtAStartupModule {}
