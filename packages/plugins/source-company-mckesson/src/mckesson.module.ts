import { Module } from '@nestjs/common';
import { McKessonService } from './mckesson.service';

@Module({ providers: [McKessonService], exports: [McKessonService] })
export class McKessonModule {}
