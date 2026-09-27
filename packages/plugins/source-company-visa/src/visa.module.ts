import { Module } from '@nestjs/common';
import { VisaService } from './visa.service';

@Module({ providers: [VisaService], exports: [VisaService] })
export class VisaModule {}
