import { Module } from '@nestjs/common';
import { GetMaxSpaceService } from './getmaxspace.service';

@Module({
  providers: [GetMaxSpaceService],
  exports: [GetMaxSpaceService],
})
export class GetMaxSpaceModule {}
