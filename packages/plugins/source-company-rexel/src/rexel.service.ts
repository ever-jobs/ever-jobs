import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Rexel — Global distributor of electrical supplies and energy products, including solar and battery storage systems.
 *
 * Rexel is a French distributor of electrical products and energy solutions
 * to installers, industry and end-users. Its offering includes solar panels,
 * inverters, battery energy storage and related products supporting
 * electrification and renewable energy adoption.
 *
 * Sector: Electrical & Energy Distribution. HQ: Paris, Ile-de-France, France.
 *
 * Source: SmartRecruiters job board, company identifier `REXEL1`
 * (`https://jobs.smartrecruiters.com/REXEL1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'REXEL1';
const COMPANY_NAME = 'Rexel';

@SourcePlugin({
  site: Site.REXEL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RexelService implements IScraper {
  private readonly logger = new Logger(RexelService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Rexel',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Rexel: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.REXEL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'rexel-');
      }
    }

    this.logger.log(`Rexel: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
