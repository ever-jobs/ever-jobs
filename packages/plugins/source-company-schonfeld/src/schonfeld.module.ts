import { Module } from '@nestjs/common';
import { SchonfeldService } from './schonfeld.service';

@Module({ providers: [SchonfeldService], exports: [SchonfeldService] })
export class SchonfeldModule {}
