import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * True Zero Technologies — Veteran-owned cybersecurity and technology services firm supporting US federal customers.
 *
 * True Zero Technologies is a veteran-owned small business providing
 * cybersecurity and technology services to US federal customers, including
 * security operations, incident response, configuration management,
 * compliance (RMF/FISMA), and data analytics.
 *
 * Sector: Cybersecurity (Federal Security Services). HQ: Reston, Virginia, United States.
 *
 * Source: Lever job board, company slug `truezerotech`
 * (`https://jobs.lever.co/truezerotech`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'truezerotech';
const COMPANY_NAME = 'True Zero Technologies';

@SourcePlugin({
  site: Site.TRUE_ZERO_TECHNOLOGIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TrueZeroTechnologiesService implements IScraper {
  private readonly logger = new Logger(TrueZeroTechnologiesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape True Zero Technologies',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `True Zero Technologies: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TRUE_ZERO_TECHNOLOGIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'truezerotech-');
      }
    }

    this.logger.log(`True Zero Technologies: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
