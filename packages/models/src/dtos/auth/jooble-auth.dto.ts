import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Jooble API credentials.
 *
 * Can be supplied per-request via `ScraperInputDto.auth.jooble`
 * or configured globally via environment variables.
 */
export class JoobleAuthDto {
  @ApiPropertyOptional({ description: 'Jooble API key (overrides JOOBLE_API_KEY env var)' })
  @IsOptional()
  @IsString()
  apiKey?: string;

  constructor(partial?: Partial<JoobleAuthDto>) {
    if (partial) Object.assign(this, partial);
  }
}
