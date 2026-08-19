import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Securitas — Swedish multinational providing protective and security services.
 *
 * Securitas AB is a Swedish multinational security-services company
 * headquartered in Stockholm. It provides on-site guarding, mobile and
 * monitoring services, and technology-driven and risk-management security
 * solutions across many countries, and is publicly listed in Sweden.
 *
 * Sector: Security services. HQ: Stockholm, Sweden.
 *
 * Source: SmartRecruiters job board, company identifier `Securitas`
 * (`https://jobs.smartrecruiters.com/Securitas`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Securitas';
const COMPANY_NAME = 'Securitas';

@SourcePlugin({
  site: Site.SECURITAS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SecuritasService implements IScraper {
  private readonly logger = new Logger(SecuritasService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Securitas',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Securitas: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SECURITAS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'securitas-');
      }
    }

    this.logger.log(`Securitas: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
