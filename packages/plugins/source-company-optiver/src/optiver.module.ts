import { Module } from '@nestjs/common';
import { OptiverService } from './optiver.service';

@Module({ providers: [OptiverService], exports: [OptiverService] })
export class OptiverModule {}
