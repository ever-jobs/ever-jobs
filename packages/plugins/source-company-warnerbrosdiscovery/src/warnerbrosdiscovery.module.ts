import { Module } from '@nestjs/common';
import { WarnerBrosDiscoveryService } from './warnerbrosdiscovery.service';

@Module({ providers: [WarnerBrosDiscoveryService], exports: [WarnerBrosDiscoveryService] })
export class WarnerBrosDiscoveryModule {}
