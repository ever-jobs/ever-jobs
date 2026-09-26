import { Module } from '@nestjs/common';
import { ThermwoodService } from './thermwood.service';

@Module({
  providers: [ThermwoodService],
  exports: [ThermwoodService],
})
export class ThermwoodModule {}
