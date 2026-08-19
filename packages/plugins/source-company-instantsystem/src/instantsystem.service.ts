import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Instant System — Mobility-as-a-Service SaaS provider building white-label multimodal urban-mobility apps for transit authorities.
 *
 * Instant System is a French company based in Sophia-Antipolis (Biot) that
 * develops web and mobile applications for urban mobility, offering
 * white-label Mobility-as-a-Service platforms to public transit authorities
 * that combine buses, trains, bikes, scooters and ride-sharing. Careers are
 * hosted on Recruitee at instantsystem.recruitee.com.
 *
 * Sector: MobilityTech / SaaS. HQ: Sophia-Antipolis, France.
 *
 * Source: Recruitee careers board, subdomain `instantsystem`
 * (`https://instantsystem.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'instantsystem';
const COMPANY_NAME = 'Instant System';

@SourcePlugin({
  site: Site.INSTANT_SYSTEM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class InstantSystemService implements IScraper {
  private readonly logger = new Logger(InstantSystemService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Instant System',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Instant System: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INSTANT_SYSTEM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'instantsystem-');
      }
    }

    this.logger.log(`Instant System: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
