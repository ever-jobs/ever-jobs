import { Module } from '@nestjs/common';
import { LeidosService } from './leidos.service';

@Module({ providers: [LeidosService], exports: [LeidosService] })
export class LeidosModule {}
