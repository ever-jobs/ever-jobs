import { Module } from '@nestjs/common';
import { AdzunaService } from './adzuna.service';

@Module({
  providers: [AdzunaService],
  exports: [AdzunaService],
})
export class AdzunaModule {}
