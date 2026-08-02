import { Module } from '@nestjs/common';
import { GaladyneIoService } from './galadyne_io.service';

@Module({
  providers: [GaladyneIoService],
  exports: [GaladyneIoService],
})
export class GaladyneIoModule {}
