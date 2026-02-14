import { Module } from '@nestjs/common';
import { UsajobsService } from './usajobs.service';

@Module({
  providers: [UsajobsService],
  exports: [UsajobsService],
})
export class UsajobsModule {}
