import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Aurora Solar — Cloud software for designing, selling, and managing solar photovoltaic installations.
 *
 * Aurora Solar develops cloud-based software used by solar installers and
 * providers to design photovoltaic systems, generate sales proposals, and
 * manage projects. Its platform includes remote roof modeling and shading
 * analysis for solar system design. The company serves residential and
 * commercial solar businesses.
 *
 * Sector: Solar software. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `aurorasolar`
 * (`https://jobs.ashbyhq.com/aurorasolar`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'aurorasolar';
const COMPANY_NAME = 'Aurora Solar';

@SourcePlugin({
  site: Site.AURORA_SOLAR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AuroraSolarService implements IScraper {
  private readonly logger = new Logger(AuroraSolarService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Aurora Solar',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Aurora Solar: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AURORA_SOLAR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'aurorasolar-');
      }
    }

    this.logger.log(`Aurora Solar: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
