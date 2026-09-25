import { Module } from '@nestjs/common';
import { TauRoboticsService } from './tau-robotics.service';

@Module({
  providers: [TauRoboticsService],
  exports: [TauRoboticsService],
})
export class TauRoboticsModule {}
