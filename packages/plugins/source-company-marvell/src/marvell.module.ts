import { Module } from '@nestjs/common';
import { MarvellService } from './marvell.service';

@Module({ providers: [MarvellService], exports: [MarvellService] })
export class MarvellModule {}
