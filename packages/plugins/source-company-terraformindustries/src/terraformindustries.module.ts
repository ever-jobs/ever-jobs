import { Module } from '@nestjs/common';
import { TerraformIndustriesService } from './terraformindustries.service';

@Module({
  providers: [TerraformIndustriesService],
  exports: [TerraformIndustriesService],
})
export class TerraformIndustriesModule {}
