import { Module } from '@nestjs/common';
import { FidelityService } from './fidelity.service';

@Module({ providers: [FidelityService], exports: [FidelityService] })
export class FidelityModule {}
