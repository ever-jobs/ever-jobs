import { Module } from '@nestjs/common';
import { VaticLabsService } from './vaticlabs.service';

@Module({ providers: [VaticLabsService], exports: [VaticLabsService] })
export class VaticLabsModule {}
