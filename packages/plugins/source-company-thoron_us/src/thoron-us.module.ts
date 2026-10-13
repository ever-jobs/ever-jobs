import { Module } from '@nestjs/common';
import { ThoronUsService } from './thoron-us.service';

@Module({
  providers: [ThoronUsService],
  exports: [ThoronUsService],
})
export class ThoronUsModule {}
