import { Module } from '@nestjs/common';
import { WellsFargoService } from './wellsfargo.service';

@Module({ providers: [WellsFargoService], exports: [WellsFargoService] })
export class WellsFargoModule {}
