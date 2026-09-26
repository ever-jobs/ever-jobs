import { Module } from '@nestjs/common';
import { GResearchService } from './gresearch.service';

@Module({ providers: [GResearchService], exports: [GResearchService] })
export class GResearchModule {}
