import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * CareerJet API credentials.
 *
 * Can be supplied per-request via `ScraperInputDto.auth.careerjet`
 * or configured globally via environment variables.
 */
export class CareerjetAuthDto {
  @ApiPropertyOptional({ description: 'CareerJet affiliate ID (overrides CAREERJET_AFFID env var)' })
  @IsOptional()
  @IsString()
  affId?: string;

  constructor(partial?: Partial<CareerjetAuthDto>) {
    if (partial) Object.assign(this, partial);
  }
}
