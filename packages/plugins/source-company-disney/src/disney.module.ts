import { Module } from '@nestjs/common';
import { DisneyService } from './disney.service';

@Module({ providers: [DisneyService], exports: [DisneyService] })
export class DisneyModule {}
