import { Module } from '@nestjs/common';
import { SolideonService } from './solideon.service';

@Module({
  providers: [SolideonService],
  exports: [SolideonService],
})
export class SolideonModule {}
