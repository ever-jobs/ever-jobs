import { Module } from '@nestjs/common';
import { GenevaTradingService } from './genevatrading.service';

@Module({ providers: [GenevaTradingService], exports: [GenevaTradingService] })
export class GenevaTradingModule {}
