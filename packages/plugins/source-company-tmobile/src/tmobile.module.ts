import { Module } from '@nestjs/common';
import { TMobileService } from './tmobile.service';

@Module({ providers: [TMobileService], exports: [TMobileService] })
export class TMobileModule {}
