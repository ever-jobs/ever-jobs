import { Module } from '@nestjs/common';
import { BuildcoverService } from './buildcover.service';

@Module({
  providers: [BuildcoverService],
  exports: [BuildcoverService],
})
export class BuildcoverModule {}
