import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Healthtech-1 — Automates repetitive administrative processes for healthcare providers.
 *
 * Healthtech-1 builds software that automates repetitive administrative
 * workflows for healthcare providers, including GP practices in the UK. Its
 * products target tasks such as patient registration. The company is based
 * in London.
 *
 * Sector: Healthtech (primary care automation). HQ: London, England, UK.
 *
 * Source: Ashby job board, company slug `healthtech-1`
 * (`https://jobs.ashbyhq.com/healthtech-1`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'healthtech-1';
const COMPANY_NAME = 'Healthtech-1';

@SourcePlugin({
  site: Site.HEALTHTECH_1,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class Healthtech1Service implements IScraper {
  private readonly logger = new Logger(Healthtech1Service.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Healthtech-1',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Healthtech-1: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HEALTHTECH_1;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'healthtech1-');
      }
    }

    this.logger.log(`Healthtech-1: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
