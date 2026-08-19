import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Faktion — AI software and applied-research company building custom AI solutions.
 *
 * Faktion is an Antwerp-based AI software company building custom and
 * generative-AI solutions and applied research. Its Recruitee board at
 * faktionbv1.recruitee.com listed 7 offers, all Antwerp-based, including AI
 * engineers, an applied-research AI engineer, and full-stack engineers.
 *
 * Sector: Software / AI. HQ: Antwerp, Belgium.
 *
 * Source: Recruitee careers board, subdomain `faktionbv1`
 * (`https://faktionbv1.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'faktionbv1';
const COMPANY_NAME = 'Faktion';

@SourcePlugin({
  site: Site.FAKTION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FaktionService implements IScraper {
  private readonly logger = new Logger(FaktionService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Faktion',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Faktion: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FAKTION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'faktion-');
      }
    }

    this.logger.log(`Faktion: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
