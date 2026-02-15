import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Adzuna API credentials.
 *
 * Can be supplied per-request via `ScraperInputDto.auth.adzuna`
 * or configured globally via environment variables.
 */
export class AdzunaAuthDto {
  @ApiPropertyOptional({ description: 'Adzuna application ID (overrides ADZUNA_APP_ID env var)' })
  @IsOptional()
  @IsString()
  appId?: string;

  @ApiPropertyOptional({ description: 'Adzuna application key (overrides ADZUNA_APP_KEY env var)' })
  @IsOptional()
  @IsString()
  appKey?: string;

  constructor(partial?: Partial<AdzunaAuthDto>) {
    if (partial) Object.assign(this, partial);
  }
}
