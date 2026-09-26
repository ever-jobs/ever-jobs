import { Module } from '@nestjs/common';
import { CvsHealthService } from './cvshealth.service';

@Module({ providers: [CvsHealthService], exports: [CvsHealthService] })
export class CvsHealthModule {}
