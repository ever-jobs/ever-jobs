import { Module } from '@nestjs/common';
import { TowerResearchCapitalService } from './towerresearchcapital.service';

@Module({ providers: [TowerResearchCapitalService], exports: [TowerResearchCapitalService] })
export class TowerResearchCapitalModule {}
