import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Solestial — Manufactures radiation-hardened silicon solar cells and panels for satellites and space missions.
 *
 * Solestial builds silicon-based solar power technology engineered to
 * survive the space environment (radiation, vacuum, launch shock) to provide
 * power for satellites, lunar missions, and other spacecraft.
 *
 * Sector: Clean energy / Space solar. HQ: Tempe, Arizona, USA.
 *
 * Source: Lever job board, company slug `solestial`
 * (`https://jobs.lever.co/solestial`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'solestial';
const COMPANY_NAME = 'Solestial';

@SourcePlugin({
  site: Site.SOLESTIAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SolestialService implements IScraper {
  private readonly logger = new Logger(SolestialService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Solestial',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Solestial: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SOLESTIAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'solestial-');
      }
    }

    this.logger.log(`Solestial: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
