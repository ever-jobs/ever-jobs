import { Module } from '@nestjs/common';
import { HumanaService } from './humana.service';

@Module({ providers: [HumanaService], exports: [HumanaService] })
export class HumanaModule {}
