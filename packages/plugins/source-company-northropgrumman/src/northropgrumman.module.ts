import { Module } from '@nestjs/common';
import { NorthropGrummanService } from './northropgrumman.service';

@Module({ providers: [NorthropGrummanService], exports: [NorthropGrummanService] })
export class NorthropGrummanModule {}
