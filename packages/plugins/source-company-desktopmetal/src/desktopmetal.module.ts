import { Module } from '@nestjs/common';
import { DesktopmetalService } from './desktopmetal.service';

@Module({
  providers: [DesktopmetalService],
  exports: [DesktopmetalService],
})
export class DesktopmetalModule {}
