import { Module } from '@nestjs/common';
import { FlymotionusService } from './flymotionus.service';

@Module({
  providers: [FlymotionusService],
  exports: [FlymotionusService],
})
export class FlymotionusModule {}
