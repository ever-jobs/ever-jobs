import { Module } from '@nestjs/common';
import { JnjService } from './jnj.service';

@Module({ providers: [JnjService], exports: [JnjService] })
export class JnjModule {}
