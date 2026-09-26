import { Module } from '@nestjs/common';
import { ExpediaGroupService } from './expediagroup.service';

@Module({ providers: [ExpediaGroupService], exports: [ExpediaGroupService] })
export class ExpediaGroupModule {}
