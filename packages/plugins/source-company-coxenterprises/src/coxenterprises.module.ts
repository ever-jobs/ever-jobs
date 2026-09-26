import { Module } from '@nestjs/common';
import { CoxEnterprisesService } from './coxenterprises.service';

@Module({ providers: [CoxEnterprisesService], exports: [CoxEnterprisesService] })
export class CoxEnterprisesModule {}
