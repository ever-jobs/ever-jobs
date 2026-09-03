import { Module } from '@nestjs/common';
import { RdwService } from './rdw.service';

@Module({
  providers: [RdwService],
  exports: [RdwService],
})
export class RdwModule {}
