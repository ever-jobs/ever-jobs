import { Module } from '@nestjs/common';
import { MavenSecuritiesService } from './mavensecurities.service';

@Module({ providers: [MavenSecuritiesService], exports: [MavenSecuritiesService] })
export class MavenSecuritiesModule {}
