import { Module } from '@nestjs/common';
import { VelontraService } from './velontra.service';

@Module({
  providers: [VelontraService],
  exports: [VelontraService],
})
export class VelontraModule {}
