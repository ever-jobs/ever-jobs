import { Module } from '@nestjs/common';
import { BridgewaterService } from './bridgewater.service';

@Module({ providers: [BridgewaterService], exports: [BridgewaterService] })
export class BridgewaterModule {}
