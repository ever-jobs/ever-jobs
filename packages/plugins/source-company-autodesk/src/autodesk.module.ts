import { Module } from '@nestjs/common';
import { AutodeskService } from './autodesk.service';

@Module({ providers: [AutodeskService], exports: [AutodeskService] })
export class AutodeskModule {}
