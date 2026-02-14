import { Module } from '@nestjs/common';
import { ReedService } from './reed.service';

@Module({
  providers: [ReedService],
  exports: [ReedService],
})
export class ReedModule {}
