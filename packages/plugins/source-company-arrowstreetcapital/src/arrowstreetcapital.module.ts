import { Module } from '@nestjs/common';
import { ArrowstreetCapitalService } from './arrowstreetcapital.service';

@Module({ providers: [ArrowstreetCapitalService], exports: [ArrowstreetCapitalService] })
export class ArrowstreetCapitalModule {}
