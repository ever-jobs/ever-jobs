import { Module } from '@nestjs/common';
import { HpeService } from './hpe.service';

@Module({ providers: [HpeService], exports: [HpeService] })
export class HpeModule {}
