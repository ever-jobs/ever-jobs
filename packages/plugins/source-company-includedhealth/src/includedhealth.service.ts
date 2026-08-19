import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Included Health — Virtual-first healthcare navigation and integrated care platform for employers and health plans.
 *
 * Included Health provides healthcare navigation, virtual primary and
 * behavioral care, and specialty care guidance to members through employer
 * and health-plan partnerships. It combines care coordination with
 * telehealth clinical services.
 *
 * Sector: Digital Health. HQ: San Francisco, California, USA.
 *
 * Source: Lever job board, company slug `includedhealth`
 * (`https://jobs.lever.co/includedhealth`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'includedhealth';
const COMPANY_NAME = 'Included Health';

@SourcePlugin({
  site: Site.INCLUDED_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class IncludedHealthService implements IScraper {
  private readonly logger = new Logger(IncludedHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Included Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Included Health: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INCLUDED_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'includedhealth-');
      }
    }

    this.logger.log(`Included Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
