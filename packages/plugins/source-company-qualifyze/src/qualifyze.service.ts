import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Qualifyze — Digital supply-chain compliance and auditing platform for life sciences.
 *
 * Qualifyze GmbH provides digital supply-chain compliance management for the
 * life-sciences industry, connecting manufacturers, suppliers, and a network
 * of auditors to track and manage quality and GxP compliance. It operates
 * from Frankfurt and Barcelona.
 *
 * Sector: Life-sciences compliance SaaS. HQ: Frankfurt, Germany.
 *
 * Source: Recruitee careers board, subdomain `qualifyzegmbh`
 * (`https://qualifyzegmbh.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'qualifyzegmbh';
const COMPANY_NAME = 'Qualifyze';

@SourcePlugin({
  site: Site.QUALIFYZE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class QualifyzeService implements IScraper {
  private readonly logger = new Logger(QualifyzeService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Qualifyze',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Qualifyze: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.QUALIFYZE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'qualifyze-');
      }
    }

    this.logger.log(`Qualifyze: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
