import { Module } from '@nestjs/common';
import { VirtuService } from './virtu.service';

@Module({ providers: [VirtuService], exports: [VirtuService] })
export class VirtuModule {}
