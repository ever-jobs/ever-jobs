import { Module } from '@nestjs/common';
import { JoobleService } from './jooble.service';

@Module({
  providers: [JoobleService],
  exports: [JoobleService],
})
export class JoobleModule {}
