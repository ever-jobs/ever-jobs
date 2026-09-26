import { Module } from '@nestjs/common';
import { WorldQuantService } from './worldquant.service';

@Module({ providers: [WorldQuantService], exports: [WorldQuantService] })
export class WorldQuantModule {}
