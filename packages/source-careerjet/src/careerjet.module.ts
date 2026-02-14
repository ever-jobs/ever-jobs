import { Module } from '@nestjs/common';
import { CareerJetService } from './careerjet.service';

@Module({
  providers: [CareerJetService],
  exports: [CareerJetService],
})
export class CareerJetModule {}
