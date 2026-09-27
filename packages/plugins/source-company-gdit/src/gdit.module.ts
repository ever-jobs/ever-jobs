import { Module } from '@nestjs/common';
import { GditService } from './gdit.service';

@Module({ providers: [GditService], exports: [GditService] })
export class GditModule {}
