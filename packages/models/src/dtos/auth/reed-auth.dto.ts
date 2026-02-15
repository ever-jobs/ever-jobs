import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Reed API credentials.
 *
 * Can be supplied per-request via `ScraperInputDto.auth.reed`
 * or configured globally via environment variables.
 */
export class ReedAuthDto {
  @ApiPropertyOptional({ description: 'Reed API key (overrides REED_API_KEY env var)' })
  @IsOptional()
  @IsString()
  apiKey?: string;

  constructor(partial?: Partial<ReedAuthDto>) {
    if (partial) Object.assign(this, partial);
  }
}
