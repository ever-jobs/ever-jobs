import { Module } from '@nestjs/common';
import { RemotiveService } from './remotive.service';

@Module({
  providers: [RemotiveService],
  exports: [RemotiveService],
})
export class RemotiveModule {}
