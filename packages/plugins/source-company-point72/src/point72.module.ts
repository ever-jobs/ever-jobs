import { Module } from '@nestjs/common';
import { Point72Service } from './point72.service';

@Module({ providers: [Point72Service], exports: [Point72Service] })
export class Point72Module {}
