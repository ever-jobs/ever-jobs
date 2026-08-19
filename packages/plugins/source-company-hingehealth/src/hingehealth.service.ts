import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Hinge Health — Digital clinic for musculoskeletal (joint and muscle) care.
 *
 * Hinge Health offers a digital care platform for musculoskeletal
 * conditions, combining exercise therapy, wearable sensors, and clinical
 * support. It is offered as a benefit through employers and health plans.
 * The company is publicly traded.
 *
 * Sector: Digital health (musculoskeletal). HQ: San Francisco, CA, USA.
 *
 * Source: Ashby job board, company slug `hinge-health`
 * (`https://jobs.ashbyhq.com/hinge-health`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'hinge-health';
const COMPANY_NAME = 'Hinge Health';

@SourcePlugin({
  site: Site.HINGE_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HingeHealthService implements IScraper {
  private readonly logger = new Logger(HingeHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Hinge Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Hinge Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HINGE_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'hingehealth-');
      }
    }

    this.logger.log(`Hinge Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
