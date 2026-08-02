import { Module } from '@nestjs/common';
import { IperionxService } from './iperionx.service';

@Module({
  providers: [IperionxService],
  exports: [IperionxService],
})
export class IperionxModule {}
