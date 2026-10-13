import { Module } from '@nestjs/common';
import { WercoMfgService } from './wercomfg.service';

@Module({
  providers: [WercoMfgService],
  exports: [WercoMfgService],
})
export class WercoMfgModule {}
