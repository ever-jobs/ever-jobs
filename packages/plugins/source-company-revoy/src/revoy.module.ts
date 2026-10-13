import { Module } from '@nestjs/common';
import { RevoyService } from './revoy.service';

@Module({
  providers: [RevoyService],
  exports: [RevoyService],
})
export class RevoyModule {}
