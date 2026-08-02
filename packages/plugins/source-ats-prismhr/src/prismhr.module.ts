import { Module } from '@nestjs/common';
import { PrismhrService } from './prismhr.service';

@Module({
  providers: [PrismhrService],
  exports: [PrismhrService],
})
export class PrismhrModule {}
