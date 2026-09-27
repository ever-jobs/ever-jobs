import { Module } from '@nestjs/common';
import { BlueOriginService } from './blueorigin.service';

@Module({ providers: [BlueOriginService], exports: [BlueOriginService] })
export class BlueOriginModule {}
