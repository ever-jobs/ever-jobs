import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  CompensationDto,
  getCompensationInterval,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  parseLocationText,
  resolveCompensation,
  stripHtmlTags,
  toDateOnly,
} from '@ever-jobs/common';
import {
  NODI_GLOBAL_DEFAULT_TIMEOUT_SECONDS,
  nodiGlobalCompanyUrl,
  nodiGlobalJobsUrl,
} from './nodi_global.constants';
import {
  NodiGlobalCompany,
  NodiGlobalJobOffer,
} from './nodi_global.types';

@SourcePlugin({
  site: Site.NODI_GLOBAL,
  name: 'Nodi',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class NodiGlobalService implements IScraper {
  private readonly logger = new Logger(NodiGlobalService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const company = input.companySlug?.trim();
    if (!company) {
      this.logger.warn('No companySlug provided for Nodi scraper');
      return new JobResponseDto([]);
    }

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout:
          input.requestTimeout ?? NODI_GLOBAL_DEFAULT_TIMEOUT_SECONDS,
      });

      const [offers, info] = await Promise.all([
        this.fetchJson<NodiGlobalJobOffer[]>(
          client,
          nodiGlobalJobsUrl(company),
        ),
        this.fetchJson<NodiGlobalCompany>(
          client,
          nodiGlobalCompanyUrl(company),
        ).catch(() => null),
      ]);

      const companyName = info?.company_name ?? null;
      const companyUrl = info?.website ?? null;

      const resultsWanted = input.resultsWanted ?? 100;
      // Plugins own `offset` (the core does not apply it): skip that many
      // usable offers, then take resultsWanted.
      let toSkip = Math.max(0, Math.floor(Number(input.offset) || 0));
      const jobs: JobPostDto[] = [];
      for (const offer of offers ?? []) {
        if (jobs.length >= resultsWanted) break;
        if (!offer?.title || !offer.id) continue;
        if (toSkip > 0) {
          toSkip--;
          continue;
        }
        jobs.push(this.toJobPost(offer, company, companyName, companyUrl));
      }

      this.logger.log(`Nodi: scraped ${jobs.length} jobs for ${company}`);
      return new JobResponseDto(jobs);
    } catch (err: unknown) {
      this.logger.error(
        `Nodi scrape failed for ${company}: ${(err as Error)?.message ?? err}`,
      );
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /** GET JSON. Isolated so tests can substitute fixtures per URL. */
  protected async fetchJson<T>(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<T | null> {
    const res = await client.get<T>(url);
    return (res.data as T) ?? null;
  }

  private toJobPost(
    offer: NodiGlobalJobOffer,
    company: string,
    companyName: string | null,
    companyUrl: string | null,
  ): JobPostDto {
    const jobUrl =
      offer.magic_link ??
      `https://app.nodi.global/jobs/public/${offer.id}`;

    const locationText = (offer.location ?? '').trim();
    const { location } = locationText
      ? parseLocationText(locationText)
      : { location: null };

    const jobType = getJobTypeFromString(offer.type ?? '');

    const modality = (offer.modality ?? '').toLowerCase();
    const isRemote =
      modality === 'remote' || locationText.toLowerCase().includes('remote');
    const workFromHomeType = modality.includes('hybrid')
      ? 'Hybrid'
      : isRemote
        ? 'Remote'
        : modality.includes('on-site') || modality.includes('onsite')
          ? 'On Site'
          : null;

    const interval = getCompensationInterval(offer.frequency ?? '');
    const compensation = resolveCompensation({
      structured:
        offer.min_salary != null || offer.max_salary != null
          ? new CompensationDto({
              minAmount: offer.min_salary ?? undefined,
              maxAmount: offer.max_salary ?? undefined,
              currency: offer.currency ?? 'USD',
              interval,
            })
          : null,
      text: offer.description,
    });

    return new JobPostDto({
      id: `nodi_global-${company}-${offer.id}`,
      site: Site.NODI_GLOBAL,
      title: offer.title!,
      companyName: companyName ?? company,
      ...(companyUrl ? { companyUrl } : {}),
      jobUrl,
      applyUrl: jobUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      description: (stripHtmlTags(offer.description ?? '') ?? '').trim() || null,
      ...(compensation ? { compensation } : {}),
      datePosted: offer.created_at ? toDateOnly(offer.created_at) : null,
      isRemote,
      ...(workFromHomeType ? { workFromHomeType } : {}),
      ...(jobType ? { jobType: [jobType] } : {}),
      ...(offer.type ? { employmentType: offer.type } : {}),
      ...(offer.department ? { department: offer.department } : {}),
      atsId: offer.id,
      atsType: 'nodi_global',
    });
  }
}
