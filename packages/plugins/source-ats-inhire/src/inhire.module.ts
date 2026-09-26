import { Module } from '@nestjs/common';
import { InhireService } from './inhire.service';

@Module({
  providers: [InhireService],
  exports: [InhireService],
})
export class InhireModule {}
