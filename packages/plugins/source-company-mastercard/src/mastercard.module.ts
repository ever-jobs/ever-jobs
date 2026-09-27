import { Module } from '@nestjs/common';
import { MastercardService } from './mastercard.service';

@Module({ providers: [MastercardService], exports: [MastercardService] })
export class MastercardModule {}
