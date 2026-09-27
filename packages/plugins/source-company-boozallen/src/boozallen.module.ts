import { Module } from '@nestjs/common';
import { BoozAllenService } from './boozallen.service';

@Module({ providers: [BoozAllenService], exports: [BoozAllenService] })
export class BoozAllenModule {}
