import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Relais & Châteaux — Association of independent luxury hotels and restaurants worldwide.
 *
 * Relais & Châteaux is a France-based association of independently owned
 * luxury hotels and gourmet restaurants located across numerous countries.
 * Headquartered in Paris, it supports member properties and recruits for
 * hospitality and culinary roles.
 *
 * Sector: Hospitality. HQ: Paris, Ile-de-France, France.
 *
 * Source: SmartRecruiters job board, company identifier `RelaisChateaux`
 * (`https://jobs.smartrecruiters.com/RelaisChateaux`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'RelaisChateaux';
const COMPANY_NAME = 'Relais & Châteaux';

@SourcePlugin({
  site: Site.RELAIS_CH_TEAUX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RelaisChTeauxService implements IScraper {
  private readonly logger = new Logger(RelaisChTeauxService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Relais & Châteaux',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Relais & Châteaux: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RELAIS_CH_TEAUX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'relaischteaux-');
      }
    }

    this.logger.log(`Relais & Châteaux: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
