import { Module } from '@nestjs/common';
import { RemoteOkService } from './remoteok.service';

@Module({
  providers: [RemoteOkService],
  exports: [RemoteOkService],
})
export class RemoteOkModule {}
