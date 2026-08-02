import { Module } from '@nestjs/common';
import { VightaeroService } from './vightaero.service';

@Module({
  providers: [VightaeroService],
  exports: [VightaeroService],
})
export class VightaeroModule {}
