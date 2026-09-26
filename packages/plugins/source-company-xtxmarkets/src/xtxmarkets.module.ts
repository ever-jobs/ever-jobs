import { Module } from '@nestjs/common';
import { XtxMarketsService } from './xtxmarkets.service';

@Module({ providers: [XtxMarketsService], exports: [XtxMarketsService] })
export class XtxMarketsModule {}
