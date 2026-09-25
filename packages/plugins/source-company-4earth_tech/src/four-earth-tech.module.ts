import { Module } from '@nestjs/common';
import { FourEarthTechService } from './four-earth-tech.service';

@Module({
  providers: [FourEarthTechService],
  exports: [FourEarthTechService],
})
export class FourEarthTechModule {}
