import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Tempo — Layer-1 blockchain purpose-built for stablecoins and real-world payments.
 *
 * Tempo is a layer-1 blockchain purpose-built for stablecoins and real-world
 * payments. It draws on payments and crypto engineering expertise from its
 * founding backers. The project focuses on blockchain infrastructure for
 * payment use cases.
 *
 * Sector: Layer-1 blockchain / payments. HQ: Remote.
 *
 * Source: Ashby job board, company slug `tempo-xyz`
 * (`https://jobs.ashbyhq.com/tempo-xyz`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'tempo-xyz';
const COMPANY_NAME = 'Tempo';

@SourcePlugin({
  site: Site.TEMPO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TempoService implements IScraper {
  private readonly logger = new Logger(TempoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Tempo',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Tempo: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TEMPO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'tempo-');
      }
    }

    this.logger.log(`Tempo: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
