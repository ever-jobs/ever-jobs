import { Module } from '@nestjs/common';
import { HpService } from './hp.service';

@Module({ providers: [HpService], exports: [HpService] })
export class HpModule {}
