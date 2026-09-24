import { Module } from '@nestjs/common';
import { TargetService } from './target.service';

@Module({ providers: [TargetService], exports: [TargetService] })
export class TargetModule {}
