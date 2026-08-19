import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Glass Health — Clinical decision support platform applying AI for physicians.
 *
 * Glass Health builds an AI-powered clinical decision support platform that
 * helps physicians generate differential diagnoses and clinical plans,
 * founded by a physician-led team.
 *
 * Sector: Health Tech / Clinical AI. HQ: San Francisco, California, USA.
 *
 * Source: Lever job board, company slug `glass-health-inc`
 * (`https://jobs.lever.co/glass-health-inc`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'glass-health-inc';
const COMPANY_NAME = 'Glass Health';

@SourcePlugin({
  site: Site.GLASS_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GlassHealthService implements IScraper {
  private readonly logger = new Logger(GlassHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Glass Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Glass Health: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GLASS_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'glasshealthinc-');
      }
    }

    this.logger.log(`Glass Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
