import { Module } from '@nestjs/common';
import { MundaneCoService } from './mundane-co.service';

@Module({
  providers: [MundaneCoService],
  exports: [MundaneCoService],
})
export class MundaneCoModule {}
