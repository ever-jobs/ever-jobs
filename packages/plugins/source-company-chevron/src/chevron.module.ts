import { Module } from '@nestjs/common';
import { ChevronService } from './chevron.service';

@Module({ providers: [ChevronService], exports: [ChevronService] })
export class ChevronModule {}
