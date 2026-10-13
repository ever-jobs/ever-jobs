import { Module } from '@nestjs/common';
import { CommaAiService } from './comma-ai.service';

@Module({
  providers: [CommaAiService],
  exports: [CommaAiService],
})
export class CommaAiModule {}
