import { Module } from '@nestjs/common';
import { OctbrAiService } from './octbr_ai.service';

@Module({ providers: [OctbrAiService], exports: [OctbrAiService] })
export class OctbrAiModule {}
