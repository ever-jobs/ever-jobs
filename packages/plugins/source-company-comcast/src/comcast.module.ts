import { Module } from '@nestjs/common';
import { ComcastService } from './comcast.service';

@Module({ providers: [ComcastService], exports: [ComcastService] })
export class ComcastModule {}
