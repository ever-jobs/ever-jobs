import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Delivery Hero — Local delivery technology platform operating across many countries.
 *
 * Delivery Hero operates online food ordering and quick-commerce delivery
 * platforms across numerous countries. It builds large-scale consumer apps,
 * logistics software, and backend engineering systems. The company is
 * publicly traded.
 *
 * Sector: Technology platform (online food and quick commerce). HQ: Berlin, Germany.
 *
 * Source: SmartRecruiters job board, company identifier `DeliveryHero`
 * (`https://jobs.smartrecruiters.com/DeliveryHero`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'DeliveryHero';
const COMPANY_NAME = 'Delivery Hero';

@SourcePlugin({
  site: Site.DELIVERY_HERO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DeliveryHeroService implements IScraper {
  private readonly logger = new Logger(DeliveryHeroService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Delivery Hero',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Delivery Hero: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DELIVERY_HERO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'deliveryhero-');
      }
    }

    this.logger.log(`Delivery Hero: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
