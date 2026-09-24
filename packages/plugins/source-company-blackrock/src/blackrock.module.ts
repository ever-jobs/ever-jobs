import { Module } from '@nestjs/common';
import { BlackRockService } from './blackrock.service';

@Module({ providers: [BlackRockService], exports: [BlackRockService] })
export class BlackRockModule {}
