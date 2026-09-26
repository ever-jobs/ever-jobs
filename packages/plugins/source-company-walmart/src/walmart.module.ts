import { Module } from '@nestjs/common';
import { WalmartService } from './walmart.service';

@Module({ providers: [WalmartService], exports: [WalmartService] })
export class WalmartModule {}
