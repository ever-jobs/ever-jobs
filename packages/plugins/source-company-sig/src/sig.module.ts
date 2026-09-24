import { Module } from '@nestjs/common';
import { SigService } from './sig.service';

@Module({ providers: [SigService], exports: [SigService] })
export class SigModule {}
