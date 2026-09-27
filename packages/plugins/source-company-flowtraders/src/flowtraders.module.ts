import { Module } from '@nestjs/common';
import { FlowTradersService } from './flowtraders.service';

@Module({ providers: [FlowTradersService], exports: [FlowTradersService] })
export class FlowTradersModule {}
