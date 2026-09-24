import { Module } from '@nestjs/common';
import { PfizerService } from './pfizer.service';

@Module({ providers: [PfizerService], exports: [PfizerService] })
export class PfizerModule {}
