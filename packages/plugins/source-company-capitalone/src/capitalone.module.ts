import { Module } from '@nestjs/common';
import { CapitalOneService } from './capitalone.service';

@Module({ providers: [CapitalOneService], exports: [CapitalOneService] })
export class CapitalOneModule {}
