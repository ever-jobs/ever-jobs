import { Module } from '@nestjs/common';
import { RedHatService } from './redhat.service';

@Module({ providers: [RedHatService], exports: [RedHatService] })
export class RedHatModule {}
