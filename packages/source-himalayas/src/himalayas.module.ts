import { Module } from '@nestjs/common';
import { HimalayasService } from './himalayas.service';

@Module({
  providers: [HimalayasService],
  exports: [HimalayasService],
})
export class HimalayasModule {}
