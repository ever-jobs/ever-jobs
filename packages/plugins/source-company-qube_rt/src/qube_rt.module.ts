import { Module } from '@nestjs/common';
import { QubeRtService } from './qube_rt.service';

@Module({ providers: [QubeRtService], exports: [QubeRtService] })
export class QubeRtModule {}
