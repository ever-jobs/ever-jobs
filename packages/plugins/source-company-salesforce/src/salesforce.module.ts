import { Module } from '@nestjs/common';
import { SalesforceService } from './salesforce.service';

@Module({ providers: [SalesforceService], exports: [SalesforceService] })
export class SalesforceModule {}
