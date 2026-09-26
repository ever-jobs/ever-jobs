import { Module } from '@nestjs/common';
import { AdobeService } from './adobe.service';

@Module({ providers: [AdobeService], exports: [AdobeService] })
export class AdobeModule {}
