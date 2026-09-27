import { Module } from '@nestjs/common';
import { ModernaService } from './moderna.service';

@Module({ providers: [ModernaService], exports: [ModernaService] })
export class ModernaModule {}
