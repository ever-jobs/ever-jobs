import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Floryn — Dutch SME lending fintech providing business credit under De Nederlandsche Bank supervision with a PSD2 licence.
 *
 * Floryn B.V. is a Dutch fintech based in 's-Hertogenbosch that provides
 * business credit and financing to SMEs using data-driven underwriting. It
 * operates under supervision of De Nederlandsche Bank and holds a PSD2
 * licence. Its Recruitee careers site (floryn.recruitee.com) listed roles
 * across people, marketing, analytics and software engineering. The
 * marketing alias invoicefinance.recruitee.com 302-redirects to the
 * canonical floryn board.
 *
 * Sector: SME lending / business finance. HQ: \'s-Hertogenbosch, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `floryn`
 * (`https://floryn.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'floryn';
const COMPANY_NAME = 'Floryn';

@SourcePlugin({
  site: Site.FLORYN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FlorynService implements IScraper {
  private readonly logger = new Logger(FlorynService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Floryn',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Floryn: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FLORYN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'floryn-');
      }
    }

    this.logger.log(`Floryn: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
