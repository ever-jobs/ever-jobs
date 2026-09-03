import { Module } from '@nestjs/common';
import { StratolaunchService } from './stratolaunch.service';

@Module({ providers: [StratolaunchService], exports: [StratolaunchService] })
export class StratolaunchModule {}
