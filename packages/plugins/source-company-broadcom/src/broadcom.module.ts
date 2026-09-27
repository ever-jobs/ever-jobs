import { Module } from '@nestjs/common';
import { BroadcomService } from './broadcom.service';

@Module({ providers: [BroadcomService], exports: [BroadcomService] })
export class BroadcomModule {}
