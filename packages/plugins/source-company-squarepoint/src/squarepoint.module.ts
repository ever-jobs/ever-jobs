import { Module } from '@nestjs/common';
import { SquarepointService } from './squarepoint.service';

@Module({ providers: [SquarepointService], exports: [SquarepointService] })
export class SquarepointModule {}
