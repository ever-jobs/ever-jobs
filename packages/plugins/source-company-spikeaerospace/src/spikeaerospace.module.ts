import { Module } from '@nestjs/common';
import { SpikeaerospaceService } from './spikeaerospace.service';

@Module({
  providers: [SpikeaerospaceService],
  exports: [SpikeaerospaceService],
})
export class SpikeaerospaceModule {}
