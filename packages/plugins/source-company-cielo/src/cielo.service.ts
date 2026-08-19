import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Cielo — Talent acquisition partner providing recruitment process outsourcing services.
 *
 * Cielo is a talent acquisition partner that delivers recruitment process
 * outsourcing (RPO), executive search and talent consulting services to
 * clients across industries. It operates recruiting programs globally.
 *
 * Sector: Talent acquisition / RPO. HQ: Brookfield, Wisconsin, United States.
 *
 * Source: SmartRecruiters job board, company identifier `Cielo2`
 * (`https://jobs.smartrecruiters.com/Cielo2`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Cielo2';
const COMPANY_NAME = 'Cielo';

@SourcePlugin({
  site: Site.CIELO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CieloService implements IScraper {
  private readonly logger = new Logger(CieloService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Cielo',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Cielo: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CIELO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'cielo-');
      }
    }

    this.logger.log(`Cielo: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
