import { Module } from '@nestjs/common';
import { VoleonService } from './voleon.service';

@Module({ providers: [VoleonService], exports: [VoleonService] })
export class VoleonModule {}
