import { Module } from '@nestjs/common';
import { FrameworkCoService } from './framework_co.service';

@Module({
  providers: [FrameworkCoService],
  exports: [FrameworkCoService],
})
export class FrameworkCoModule {}
