import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Skydio — Builds autonomous flight drones for enterprise, public safety, and defense.
 *
 * Skydio designs and manufactures autonomous drones and the AI-based flight
 * software that powers them, serving enterprise, public safety, and defense
 * customers. The company builds both the hardware and autonomy stack. It is
 * headquartered in San Mateo, California.
 *
 * Sector: Autonomy / Drones. HQ: San Mateo, California, USA.
 *
 * Source: Ashby job board, company slug `skydio`
 * (`https://jobs.ashbyhq.com/skydio`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'skydio';
const COMPANY_NAME = 'Skydio';

@SourcePlugin({
  site: Site.SKYDIO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SkydioService implements IScraper {
  private readonly logger = new Logger(SkydioService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Skydio',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Skydio: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SKYDIO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'skydio-');
      }
    }

    this.logger.log(`Skydio: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
