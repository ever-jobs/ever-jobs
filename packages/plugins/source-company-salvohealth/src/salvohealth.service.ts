import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Salvo Health — Virtual specialty care company focused on chronic digestive and gastrointestinal conditions.
 *
 * Salvo Health offers virtual, team-based care for chronic gastrointestinal
 * conditions, combining clinicians, dietitians, and health coaches with a
 * digital care model in partnership with GI providers.
 *
 * Sector: Digital Health. HQ: New York, New York, USA.
 *
 * Source: Lever job board, company slug `salvohealth`
 * (`https://jobs.lever.co/salvohealth`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'salvohealth';
const COMPANY_NAME = 'Salvo Health';

@SourcePlugin({
  site: Site.SALVO_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SalvoHealthService implements IScraper {
  private readonly logger = new Logger(SalvoHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Salvo Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Salvo Health: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SALVO_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'salvohealth-');
      }
    }

    this.logger.log(`Salvo Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
