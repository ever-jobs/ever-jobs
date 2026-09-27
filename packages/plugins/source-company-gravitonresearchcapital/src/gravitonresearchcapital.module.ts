import { Module } from '@nestjs/common';
import { GravitonResearchCapitalService } from './gravitonresearchcapital.service';

@Module({ providers: [GravitonResearchCapitalService], exports: [GravitonResearchCapitalService] })
export class GravitonResearchCapitalModule {}
