import { IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UpworkAuthDto } from './upwork-auth.dto';
import { UsajobsAuthDto } from './usajobs-auth.dto';
import { AdzunaAuthDto } from './adzuna-auth.dto';
import { ReedAuthDto } from './reed-auth.dto';
import { JoobleAuthDto } from './jooble-auth.dto';
import { CareerjetAuthDto } from './careerjet-auth.dto';
import { ExaAuthDto } from './exa-auth.dto';

/**
 * Per-request authentication credentials for individual sources.
 *
 * When provided in `ScraperInputDto.auth`, these values override
 * the corresponding environment-variable configuration for that source.
 *
 * Each property is keyed by source name and is independently optional —
 * only include credentials for the source(s) you want to override.
 */
export class ScraperAuthDto {
  @ApiPropertyOptional({
    type: () => UpworkAuthDto,
    description: 'Upwork OAuth2 credentials (overrides UPWORK_* env vars)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpworkAuthDto)
  upwork?: UpworkAuthDto;

  @ApiPropertyOptional({
    type: () => UsajobsAuthDto,
    description: 'USAJobs API credentials (overrides USAJOBS_* env vars)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UsajobsAuthDto)
  usajobs?: UsajobsAuthDto;

  @ApiPropertyOptional({
    type: () => AdzunaAuthDto,
    description: 'Adzuna API credentials (overrides ADZUNA_* env vars)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AdzunaAuthDto)
  adzuna?: AdzunaAuthDto;

  @ApiPropertyOptional({
    type: () => ReedAuthDto,
    description: 'Reed API credentials (overrides REED_API_KEY env var)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReedAuthDto)
  reed?: ReedAuthDto;

  @ApiPropertyOptional({
    type: () => JoobleAuthDto,
    description: 'Jooble API credentials (overrides JOOBLE_API_KEY env var)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => JoobleAuthDto)
  jooble?: JoobleAuthDto;

  @ApiPropertyOptional({
    type: () => CareerjetAuthDto,
    description: 'CareerJet API credentials (overrides CAREERJET_AFFID env var)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CareerjetAuthDto)
  careerjet?: CareerjetAuthDto;

  @ApiPropertyOptional({
    type: () => ExaAuthDto,
    description: 'Exa API credentials (overrides EXA_API_KEY env var)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExaAuthDto)
  exa?: ExaAuthDto;

  // Future sources:
  // linkedin?: LinkedInAuthDto;

  constructor(partial?: Partial<ScraperAuthDto>) {
    if (partial) Object.assign(this, partial);
  }
}
