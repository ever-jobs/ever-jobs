import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * USAJobs API credentials.
 *
 * Can be supplied per-request via `ScraperInputDto.auth.usajobs`
 * or configured globally via environment variables.
 */
export class UsajobsAuthDto {
  @ApiPropertyOptional({ description: 'USAJobs API key (overrides USAJOBS_API_KEY env var)' })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiPropertyOptional({ description: 'USAJobs contact email (overrides USAJOBS_EMAIL env var)' })
  @IsOptional()
  @IsString()
  email?: string;

  constructor(partial?: Partial<UsajobsAuthDto>) {
    if (partial) Object.assign(this, partial);
  }
}
