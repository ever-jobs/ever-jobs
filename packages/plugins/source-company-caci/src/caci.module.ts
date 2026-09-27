import { Module } from '@nestjs/common';
import { CaciService } from './caci.service';

@Module({ providers: [CaciService], exports: [CaciService] })
export class CaciModule {}
