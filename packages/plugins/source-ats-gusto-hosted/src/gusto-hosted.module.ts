import { Module } from '@nestjs/common';
import { GustoHostedService } from './gusto-hosted.service';

@Module({
  providers: [GustoHostedService],
  exports: [GustoHostedService],
})
export class GustoHostedModule {}
