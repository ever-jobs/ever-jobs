import { Module } from '@nestjs/common';
import { WorkdayIncService } from './workdayinc.service';

@Module({ providers: [WorkdayIncService], exports: [WorkdayIncService] })
export class WorkdayIncModule {}
