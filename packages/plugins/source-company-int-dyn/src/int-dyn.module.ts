import { Module } from '@nestjs/common';
import { IntDynService } from './int-dyn.service';

@Module({
  providers: [IntDynService],
  exports: [IntDynService],
})
export class IntDynModule {}
