import { Module } from '@nestjs/common';
import { PhilipsService } from './philips.service';

@Module({ providers: [PhilipsService], exports: [PhilipsService] })
export class PhilipsModule {}
