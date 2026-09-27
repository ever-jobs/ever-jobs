import { Module } from '@nestjs/common';
import { HeadlandsTechService } from './headlandstech.service';

@Module({ providers: [HeadlandsTechService], exports: [HeadlandsTechService] })
export class HeadlandsTechModule {}
