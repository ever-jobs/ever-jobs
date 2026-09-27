import { Module } from '@nestjs/common';
import { StrykerService } from './stryker.service';

@Module({ providers: [StrykerService], exports: [StrykerService] })
export class StrykerModule {}
