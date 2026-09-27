import { Module } from '@nestjs/common';
import { RtxService } from './rtx.service';

@Module({ providers: [RtxService], exports: [RtxService] })
export class RtxModule {}
