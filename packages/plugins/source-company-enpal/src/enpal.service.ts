import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Enpal — Provides subscription-based solar panels, battery storage, heat pumps, and EV charging for homes.
 *
 * Enpal is a German clean-energy company that offers residential solar
 * systems, battery storage, heat pumps, and EV charging, often on a
 * subscription or leasing model. It also operates a virtual power plant that
 * aggregates distributed home energy assets. The company serves households
 * across Germany.
 *
 * Sector: Solar / clean energy. HQ: Berlin, Germany.
 *
 * Source: Ashby job board, company slug `enpal`
 * (`https://jobs.ashbyhq.com/enpal`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'enpal';
const COMPANY_NAME = 'Enpal';

@SourcePlugin({
  site: Site.ENPAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EnpalService implements IScraper {
  private readonly logger = new Logger(EnpalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Enpal',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Enpal: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ENPAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'enpal-');
      }
    }

    this.logger.log(`Enpal: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
