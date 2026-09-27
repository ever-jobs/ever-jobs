import { Module } from '@nestjs/common';
import { PayPalService } from './paypal.service';

@Module({ providers: [PayPalService], exports: [PayPalService] })
export class PayPalModule {}
