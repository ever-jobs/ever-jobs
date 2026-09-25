import { Module } from '@nestjs/common';
import { PowerUsService } from './power-us.service';

@Module({
  providers: [PowerUsService],
  exports: [PowerUsService],
})
export class PowerUsModule {}
