import { Module } from '@nestjs/common';
import { ZillowService } from './zillow.service';

@Module({ providers: [ZillowService], exports: [ZillowService] })
export class ZillowModule {}
