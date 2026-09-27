import { Module } from '@nestjs/common';
import { MicronService } from './micron.service';

@Module({ providers: [MicronService], exports: [MicronService] })
export class MicronModule {}
