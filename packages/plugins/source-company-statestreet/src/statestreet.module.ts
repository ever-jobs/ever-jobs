import { Module } from '@nestjs/common';
import { StateStreetService } from './statestreet.service';

@Module({ providers: [StateStreetService], exports: [StateStreetService] })
export class StateStreetModule {}
