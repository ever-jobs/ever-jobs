import { Module } from '@nestjs/common';
import { NikeService } from './nike.service';

@Module({ providers: [NikeService], exports: [NikeService] })
export class NikeModule {}
