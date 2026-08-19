import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Hive Health — Health insurance and benefits platform for small and medium businesses.
 *
 * Hive Health provides health insurance and benefits plans aimed at small
 * and medium-sized businesses, with operations in the Philippines. It
 * combines insurance products with a technology platform for members and
 * employers. The company offers access to a provider network and telehealth.
 *
 * Sector: Healthtech (health insurance). HQ: Philippines / San Francisco, CA, USA.
 *
 * Source: Ashby job board, company slug `hivehealth`
 * (`https://jobs.ashbyhq.com/hivehealth`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'hivehealth';
const COMPANY_NAME = 'Hive Health';

@SourcePlugin({
  site: Site.HIVE_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HiveHealthService implements IScraper {
  private readonly logger = new Logger(HiveHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Hive Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Hive Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HIVE_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'hivehealth-');
      }
    }

    this.logger.log(`Hive Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
