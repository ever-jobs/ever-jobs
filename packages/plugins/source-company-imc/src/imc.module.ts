import { Module } from '@nestjs/common';
import { ImcService } from './imc.service';

@Module({ providers: [ImcService], exports: [ImcService] })
export class ImcModule {}
