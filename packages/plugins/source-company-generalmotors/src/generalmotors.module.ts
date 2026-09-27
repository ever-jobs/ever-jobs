import { Module } from '@nestjs/common';
import { GeneralMotorsService } from './generalmotors.service';

@Module({ providers: [GeneralMotorsService], exports: [GeneralMotorsService] })
export class GeneralMotorsModule {}
