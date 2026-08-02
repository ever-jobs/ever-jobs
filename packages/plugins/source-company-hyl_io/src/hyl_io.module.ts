import { Module } from '@nestjs/common';
import { HylIoService } from './hyl_io.service';

@Module({
  providers: [HylIoService],
  exports: [HylIoService],
})
export class HylIoModule {}
