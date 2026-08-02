import { Module } from '@nestjs/common';
import { CanekastService } from './canekast.service';

@Module({
  providers: [CanekastService],
  exports: [CanekastService],
})
export class CanekastModule {}
