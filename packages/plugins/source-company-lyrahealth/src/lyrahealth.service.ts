import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lyra Health — Mental health benefits platform for employers connecting members to therapy and coaching.
 *
 * Lyra Health provides workforce mental health benefits, matching employees
 * and dependents to therapy, coaching, and self-guided care through a
 * provider network and digital platform sold to employers.
 *
 * Sector: Digital Health / Mental Health. HQ: Burlingame, California, USA.
 *
 * Source: Lever job board, company slug `lyrahealth`
 * (`https://jobs.lever.co/lyrahealth`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'lyrahealth';
const COMPANY_NAME = 'Lyra Health';

@SourcePlugin({
  site: Site.LYRA_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LyraHealthService implements IScraper {
  private readonly logger = new Logger(LyraHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Lyra Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lyra Health: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LYRA_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'lyrahealth-');
      }
    }

    this.logger.log(`Lyra Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
