import { Module } from '@nestjs/common';
import { NanonuclearenergyService } from './nanonuclearenergy.service';

@Module({
  providers: [NanonuclearenergyService],
  exports: [NanonuclearenergyService],
})
export class NanonuclearenergyModule {}
