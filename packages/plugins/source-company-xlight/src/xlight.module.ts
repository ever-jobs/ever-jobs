import { Module } from '@nestjs/common';
import { XlightService } from './xlight.service';

@Module({
  providers: [XlightService],
  exports: [XlightService],
})
export class XlightModule {}
