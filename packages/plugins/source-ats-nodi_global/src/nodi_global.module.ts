import { Module } from '@nestjs/common';
import { NodiGlobalService } from './nodi_global.service';

@Module({ providers: [NodiGlobalService], exports: [NodiGlobalService] })
export class NodiGlobalModule {}
