import { Module } from '@nestjs/common';
import { MaraIncService } from './mara_inc.service';

@Module({
  providers: [MaraIncService],
  exports: [MaraIncService],
})
export class MaraIncModule {}
