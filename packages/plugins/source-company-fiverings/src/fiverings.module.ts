import { Module } from '@nestjs/common';
import { FiveRingsService } from './fiverings.service';

@Module({ providers: [FiveRingsService], exports: [FiveRingsService] })
export class FiveRingsModule {}
