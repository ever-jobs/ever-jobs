import { Module } from '@nestjs/common';
import { AnalogDevicesService } from './analogdevices.service';

@Module({ providers: [AnalogDevicesService], exports: [AnalogDevicesService] })
export class AnalogDevicesModule {}
