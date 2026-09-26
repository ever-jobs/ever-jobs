import { Module } from '@nestjs/common';
import { IntelService } from './intel.service';

@Module({ providers: [IntelService], exports: [IntelService] })
export class IntelModule {}
