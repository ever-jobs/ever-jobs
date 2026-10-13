import { Module } from '@nestjs/common';
import { BuildnebulaService } from './buildnebula.service';

@Module({
  providers: [BuildnebulaService],
  exports: [BuildnebulaService],
})
export class BuildnebulaModule {}
