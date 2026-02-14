import { Module } from '@nestjs/common';
import { WeWorkRemotelyService } from './weworkremotely.service';

@Module({
  providers: [WeWorkRemotelyService],
  exports: [WeWorkRemotelyService],
})
export class WeWorkRemotelyModule {}
