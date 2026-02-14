import { Module } from '@nestjs/common';
import { TeamtailorService } from './teamtailor.service';

@Module({
  providers: [TeamtailorService],
  exports: [TeamtailorService],
})
export class TeamtailorModule {}
