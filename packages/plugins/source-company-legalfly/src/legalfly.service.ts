import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * LegalFly — Legal AI platform for automating legal workflows and document review.
 *
 * LegalFly is a legal-AI company with offices in Ghent and London, building
 * a platform for the legal industry. Its Recruitee board at
 * legalfly.recruitee.com listed 5 offers, including product engineering in
 * Ghent and sales roles in London.
 *
 * Sector: Software / Legal AI. HQ: Ghent, Belgium.
 *
 * Source: Recruitee careers board, subdomain `legalfly`
 * (`https://legalfly.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'legalfly';
const COMPANY_NAME = 'LegalFly';

@SourcePlugin({
  site: Site.LEGALFLY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LegalFlyService implements IScraper {
  private readonly logger = new Logger(LegalFlyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape LegalFly',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `LegalFly: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LEGALFLY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'legalfly-');
      }
    }

    this.logger.log(`LegalFly: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
