import { Module } from '@nestjs/common';
import { CopartService } from './copart.service';

@Module({ providers: [CopartService], exports: [CopartService] })
export class CopartModule {}
