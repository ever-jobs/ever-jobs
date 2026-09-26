import { Module } from '@nestjs/common';
import { ThreeMService } from './3m.service';

@Module({ providers: [ThreeMService], exports: [ThreeMService] })
export class ThreeMModule {}
