import { Module } from '@nestjs/common';
import { MinervaHumanoidsService } from './minervahumanoids.service';

@Module({
  providers: [MinervaHumanoidsService],
  exports: [MinervaHumanoidsService],
})
export class MinervaHumanoidsModule {}
