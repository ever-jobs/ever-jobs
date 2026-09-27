import { Module } from '@nestjs/common';
import { OldMissionService } from './oldmissioncapital.service';

@Module({ providers: [OldMissionService], exports: [OldMissionService] })
export class OldMissionModule {}
