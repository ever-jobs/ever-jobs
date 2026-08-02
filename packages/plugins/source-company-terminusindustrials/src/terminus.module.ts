import { Module } from '@nestjs/common';
import { TerminusIndustrialsService } from './terminus.service';

@Module({
  providers: [TerminusIndustrialsService],
  exports: [TerminusIndustrialsService],
})
export class TerminusIndustrialsModule {}
