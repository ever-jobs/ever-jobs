import { Module } from '@nestjs/common';
import { ArbeitnowService } from './arbeitnow.service';

@Module({
  providers: [ArbeitnowService],
  exports: [ArbeitnowService],
})
export class ArbeitnowModule {}
