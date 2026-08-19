import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * EVERSANA — Provider of commercialization services to the pharmaceutical, biotech, and life sciences industries.
 *
 * EVERSANA provides integrated commercial services to the life sciences
 * industry, including market access, medical communications,
 * pharmacovigilance, and field-based sales teams for pharmaceutical and
 * biotech clients. It serves companies ranging from startups to established
 * pharmaceutical firms.
 *
 * Sector: Life Sciences Commercialization Services. HQ: Chicago, Illinois, USA.
 *
 * Source: SmartRecruiters job board, company identifier `EVERSANA1`
 * (`https://jobs.smartrecruiters.com/EVERSANA1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'EVERSANA1';
const COMPANY_NAME = 'EVERSANA';

@SourcePlugin({
  site: Site.EVERSANA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EVERSANAService implements IScraper {
  private readonly logger = new Logger(EVERSANAService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape EVERSANA',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `EVERSANA: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EVERSANA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'eversana-');
      }
    }

    this.logger.log(`EVERSANA: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
