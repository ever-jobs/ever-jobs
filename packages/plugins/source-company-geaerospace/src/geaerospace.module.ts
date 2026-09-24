import { Module } from '@nestjs/common';
import { GeAerospaceService } from './geaerospace.service';

@Module({ providers: [GeAerospaceService], exports: [GeAerospaceService] })
export class GeAerospaceModule {}
