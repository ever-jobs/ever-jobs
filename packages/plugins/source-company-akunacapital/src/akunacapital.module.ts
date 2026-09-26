import { Module } from '@nestjs/common';
import { AkunaCapitalService } from './akunacapital.service';

@Module({ providers: [AkunaCapitalService], exports: [AkunaCapitalService] })
export class AkunaCapitalModule {}
