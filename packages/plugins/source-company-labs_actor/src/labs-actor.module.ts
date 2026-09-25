import { Module } from '@nestjs/common';
import { LabsActorService } from './labs-actor.service';

@Module({
  providers: [LabsActorService],
  exports: [LabsActorService],
})
export class LabsActorModule {}
