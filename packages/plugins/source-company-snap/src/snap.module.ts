import { Module } from '@nestjs/common';
import { SnapService } from './snap.service';

@Module({ providers: [SnapService], exports: [SnapService] })
export class SnapModule {}
