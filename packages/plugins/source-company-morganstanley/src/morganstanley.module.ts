import { Module } from '@nestjs/common';
import { MorganStanleyService } from './morganstanley.service';

@Module({ providers: [MorganStanleyService], exports: [MorganStanleyService] })
export class MorganStanleyModule {}
