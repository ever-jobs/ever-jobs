import { Module } from '@nestjs/common';
import { WellfoundAtsService } from './wellfound_ats.service';

@Module({ providers: [WellfoundAtsService], exports: [WellfoundAtsService] })
export class WellfoundAtsModule {}
