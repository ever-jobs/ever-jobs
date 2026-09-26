import { Module } from '@nestjs/common';
import { JaneStreetService } from './janestreet.service';

@Module({ providers: [JaneStreetService], exports: [JaneStreetService] })
export class JaneStreetModule {}
