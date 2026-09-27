import { Module } from '@nestjs/common';
import { DrwService } from './drw.service';

@Module({ providers: [DrwService], exports: [DrwService] })
export class DrwModule {}
