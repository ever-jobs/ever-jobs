import { Module } from '@nestjs/common';
import { MotorolaSolutionsService } from './motorolasolutions.service';

@Module({ providers: [MotorolaSolutionsService], exports: [MotorolaSolutionsService] })
export class MotorolaSolutionsModule {}
