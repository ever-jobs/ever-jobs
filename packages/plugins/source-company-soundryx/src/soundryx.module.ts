import { Module } from '@nestjs/common';
import { SoundryxService } from './soundryx.service';

@Module({
  providers: [SoundryxService],
  exports: [SoundryxService],
})
export class SoundryxModule {}
