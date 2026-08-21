import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  FRANCETRAVAIL_API_URL,
  FRANCETRAVAIL_TOKEN_URL,
  FRANCETRAVAIL_HEADERS,
  FRANCETRAVAIL_DEFAULT_RESULTS,
  FRANCETRAVAIL_MAX_RESULTS,
  FRANCETRAVAIL_TOKEN_TIMEOUT_SECONDS,
} from './francetravail.constants';
import { FranceTravailTokenResponse, FranceTravailSearchResponse, FranceTravailOffer } from './francetravail.types';

@SourcePlugin({
  site: Site.FRANCETRAVAIL,
  name: 'FranceTravail',
  category: 'government',
})
@Injectable()
export class FranceTravailService implements IScraper {
  private readonly logger = new Logger(FranceTravailService.name);
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor() {
    this.clientId = process.env.FRANCETRAVAIL_CLIENT_ID ?? null;
    this.clientSecret = process.env.FRANCETRAVAIL_CLIENT_SECRET ?? null;
    if (!this.clientId || !this.clientSecret) {
      this.logger.warn(
        'FRANCETRAVAIL_CLIENT_ID or FRANCETRAVAIL_CLIENT_SECRET is not set. ' +
          'France Travail searches will return empty results. ' +
          'Register free at https://francetravail.io/',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!this.clientId || !this.clientSecret) {
      this.logger.warn('Skipping France Travail search — OAuth credentials not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = Math.min(
      input.resultsWanted ?? FRANCETRAVAIL_DEFAULT_RESULTS,
      FRANCETRAVAIL_MAX_RESULTS,
    );

    const token = await this.getAccessToken();
    if (!token) {
      this.logger.error('Failed to obtain France Travail access token');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...FRANCETRAVAIL_HEADERS,
      Authorization: `Bearer ${token}`,
    });

    const params: Record<string, string> = {
      range: `0-${resultsWanted - 1}`,
    };

    if (input.searchTerm) {
      params.motsCles = input.searchTerm;
    }

    const queryString = new URLSearchParams(params).toString();
    const url = `${FRANCETRAVAIL_API_URL}?${queryString}`;

    this.logger.log(`Fetching France Travail jobs: ${FRANCETRAVAIL_API_URL}?...`);

    try {
      const response = await client.get(url);
      const data = response.data as FranceTravailSearchResponse;

      const results = data?.resultats ?? [];
      if (results.length === 0) {
        this.logger.log('No France Travail jobs available');
        return new JobResponseDto([]);
      }

      this.logger.log(`France Travail returned ${results.length} offers`);

      const jobs: JobPostDto[] = [];

      for (const offer of results) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(offer, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping France Travail offer ${offer.id}: ${err.message}`);
        }
      }

      this.logger.log(`France Travail returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`France Travail scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    try {
      const client = createHttpClient({ timeout: FRANCETRAVAIL_TOKEN_TIMEOUT_SECONDS });
      client.setHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' });

      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
        scope: 'api_offresdemploiv2 o2dsoffre',
      }).toString();

      const response = await client.post(FRANCETRAVAIL_TOKEN_URL, body);
      const data = response.data as FranceTravailTokenResponse;

      this.accessToken = data.access_token;
      this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

      this.logger.log('France Travail OAuth token obtained');
      return this.accessToken;
    } catch (err: any) {
      this.logger.error(`France Travail token error: ${err.message}`);
      return null;
    }
  }

  private mapJob(offer: FranceTravailOffer, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!offer.intitule || !offer.id) return null;

    const jobUrl = offer.origineOffre?.urlOrigine
      ?? `https://candidat.francetravail.fr/offres/recherche/detail/${offer.id}`;

    let description: string | null = offer.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    const location = new LocationDto({
      city: offer.lieuTravail?.libelle ?? null,
      country: 'France',
    });

    let datePosted: string | null = null;
    if (offer.dateCreation) {
      try {
        datePosted = toDateOnly(offer.dateCreation);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `francetravail-${offer.id}`,
      title: offer.intitule,
      companyName: offer.entreprise?.nom ?? null,
      companyLogo: offer.entreprise?.logo ?? null,
      jobUrl,
      location,
      description,
      compensation: null,
      datePosted,
      isRemote: false,
      emails: extractEmails(description),
      site: Site.FRANCETRAVAIL,
    });
  }
}
