import { Module } from '@nestjs/common';
import { JibeService } from './jibe.service';

@Module({
  providers: [JibeService],
  exports: [JibeService],
})
export class JibeModule {}
