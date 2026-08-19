import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Transat AT — Canadian travel company operating Air Transat and holiday travel packages.
 *
 * Transat AT is a Canadian integrated travel company headquartered in
 * Montreal. It operates the airline Air Transat and offers vacation packages
 * and travel services, primarily serving leisure travelers between Canada,
 * Europe, and southern destinations.
 *
 * Sector: Travel & Airlines. HQ: Montreal, Quebec, Canada.
 *
 * Source: SmartRecruiters job board, company identifier `TransatAT1`
 * (`https://jobs.smartrecruiters.com/TransatAT1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'TransatAT1';
const COMPANY_NAME = 'Transat AT';

@SourcePlugin({
  site: Site.TRANSAT_AT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TransatATService implements IScraper {
  private readonly logger = new Logger(TransatATService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Transat AT',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Transat AT: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TRANSAT_AT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'transatat-');
      }
    }

    this.logger.log(`Transat AT: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
