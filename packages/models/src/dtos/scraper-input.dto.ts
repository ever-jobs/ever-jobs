import { IsOptional, IsString, IsBoolean, IsNumber, IsArray, IsEnum, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Site } from '../enums/site.enum';
import { JobType } from '../enums/job-type.enum';
import { DescriptionFormat } from '../enums/description-format.enum';
import { Country } from '../enums/country.enum';
import { ScraperAuthDto } from './auth/scraper-auth.dto';

export class ScraperInputDto {
  @ApiPropertyOptional({ enum: Site, isArray: true, description: 'Sites to scrape (default: all)' })
  @IsOptional()
  @IsArray()
  @IsEnum(Site, { each: true })
  siteType?: Site[];

  @ApiPropertyOptional({ description: 'Search term / keywords' })
  @IsOptional()
  @IsString()
  searchTerm?: string;

  @ApiPropertyOptional({ description: 'Google-specific search term override' })
  @IsOptional()
  @IsString()
  googleSearchTerm?: string;

  @ApiPropertyOptional({ description: 'Location to search near' })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ description: 'Distance in miles from location', default: 50 })
  @IsOptional()
  @IsNumber()
  distance?: number;

  @ApiPropertyOptional({ description: 'Only remote jobs', default: false })
  @IsOptional()
  @IsBoolean()
  isRemote?: boolean;

  @ApiPropertyOptional({ enum: JobType, description: 'Filter by job type' })
  @IsOptional()
  @IsEnum(JobType)
  jobType?: JobType;

  @ApiPropertyOptional({ description: 'Only easy-apply jobs' })
  @IsOptional()
  @IsBoolean()
  easyApply?: boolean;

  @ApiPropertyOptional({ description: 'Number of results wanted', default: 15 })
  @IsOptional()
  @IsNumber()
  resultsWanted?: number;

  @ApiPropertyOptional({ description: 'Offset for pagination', default: 0 })
  @IsOptional()
  @IsNumber()
  offset?: number;

  @ApiPropertyOptional({ description: 'Max age of listings in hours' })
  @IsOptional()
  @IsNumber()
  hoursOld?: number;

  @ApiPropertyOptional({ enum: Country, description: 'Country for Indeed/Glassdoor domain resolution' })
  @IsOptional()
  @IsEnum(Country)
  country?: Country;

  @ApiPropertyOptional({ enum: DescriptionFormat, description: 'Description output format', default: DescriptionFormat.MARKDOWN })
  @IsOptional()
  @IsEnum(DescriptionFormat)
  descriptionFormat?: DescriptionFormat;

  @ApiPropertyOptional({ description: 'Fetch full LinkedIn descriptions', default: false })
  @IsOptional()
  @IsBoolean()
  linkedinFetchDescription?: boolean;

  @ApiPropertyOptional({ description: 'LinkedIn company IDs to filter by', isArray: true })
  @IsOptional()
  @IsArray()
  linkedinCompanyIds?: number[];

  @ApiPropertyOptional({ description: 'Request timeout in seconds', default: 60 })
  @IsOptional()
  @IsNumber()
  requestTimeout?: number;

  @ApiPropertyOptional({ description: 'Proxy URLs', isArray: true })
  @IsOptional()
  @IsArray()
  proxies?: string[];

  @ApiPropertyOptional({ description: 'Custom CA certificate path' })
  @IsOptional()
  @IsString()
  caCert?: string;

  @ApiPropertyOptional({ description: 'Custom user agent string' })
  @IsOptional()
  @IsString()
  userAgent?: string;

  @ApiPropertyOptional({ description: 'Client IP address for sources that require it (e.g. CareerJet). Also useful for proxy rotation.' })
  @IsOptional()
  @IsString()
  clientIp?: string;

  @ApiPropertyOptional({ description: 'Convert all wages to annual salary equivalent', default: false })
  @IsOptional()
  @IsBoolean()
  enforceAnnualSalary?: boolean;

  @ApiPropertyOptional({ description: 'Minimum delay between requests in seconds (rate limiting)' })
  @IsOptional()
  @IsNumber()
  rateDelayMin?: number;

  @ApiPropertyOptional({ description: 'Maximum delay between requests in seconds (rate limiting)' })
  @IsOptional()
  @IsNumber()
  rateDelayMax?: number;

  @ApiPropertyOptional({ description: 'Company slug for ATS board scraping (e.g., "stripe" for Ashby, "github" for Greenhouse)' })
  @IsOptional()
  @IsString()
  companySlug?: string;

  @ApiPropertyOptional({ description: 'Maximum concurrent company scrapes for ATS sources', default: 5 })
  @IsOptional()
  @IsNumber()
  maxConcurrentCompanies?: number;

  @ApiPropertyOptional({
    type: () => ScraperAuthDto,
    description: 'Per-request authentication credentials for individual sources (overrides env vars)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ScraperAuthDto)
  auth?: ScraperAuthDto;

  constructor(partial?: Partial<ScraperInputDto>) {
    this.siteType = Object.values(Site);
    this.resultsWanted = 15;
    this.offset = 0;
    this.distance = 50;
    this.isRemote = false;
    this.country = Country.USA;
    this.descriptionFormat = DescriptionFormat.MARKDOWN;
    this.linkedinFetchDescription = false;
    this.requestTimeout = 60;
    this.maxConcurrentCompanies = 5;
    Object.assign(this, partial);
  }
}
