import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Exa API credentials.
 *
 * Can be supplied per-request via `ScraperInputDto.auth.exa`
 * or configured globally via environment variables.
 */
export class ExaAuthDto {
  @ApiPropertyOptional({ description: 'Exa API key (overrides EXA_API_KEY env var)' })
  @IsOptional()
  @IsString()
  apiKey?: string;

  constructor(partial?: Partial<ExaAuthDto>) {
    if (partial) Object.assign(this, partial);
  }
}
