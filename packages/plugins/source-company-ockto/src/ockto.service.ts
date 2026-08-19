import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Ockto — Naarden-based fintech whose platform lets consumers securely collect and share verified personal/financial data for processes like mortgage applications.
 *
 * Ockto is a Dutch fintech based in Naarden that operates a platform for
 * securely collecting and sharing verified personal and financial data from
 * trusted sources, used in flows such as mortgage applications, rental and
 * private-lease agreements. It cites financial institutions including ING,
 * Aegon and De Hypotheker as users. Its Recruitee board
 * (ockto.recruitee.com) listed engineering, sales and consulting roles with
 * posted salary ranges.
 *
 * Sector: Digital identity / financial data sharing. HQ: Naarden, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `ockto`
 * (`https://ockto.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'ockto';
const COMPANY_NAME = 'Ockto';

@SourcePlugin({
  site: Site.OCKTO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OcktoService implements IScraper {
  private readonly logger = new Logger(OcktoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Ockto',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Ockto: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OCKTO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'ockto-');
      }
    }

    this.logger.log(`Ockto: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
