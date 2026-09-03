import { Module } from '@nestjs/common';
import { TrossenroboticsService } from './trossenrobotics.service';

@Module({
  providers: [TrossenroboticsService],
  exports: [TrossenroboticsService],
})
export class TrossenroboticsModule {}
