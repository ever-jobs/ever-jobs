import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Laurel — AI time platform that automatically captures and categorizes professionals\' time.
 *
 * Laurel builds an AI-native time platform that automatically captures,
 * categorizes, and analyzes how professionals spend their time on work and
 * admin tasks, mapping time to business outcomes. It serves
 * professional-services firms such as legal, accounting, and consulting
 * practices. The company is headquartered in San Francisco.
 *
 * Sector: B2B SaaS / professional services automation. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `laurel`
 * (`https://jobs.ashbyhq.com/laurel`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'laurel';
const COMPANY_NAME = 'Laurel';

@SourcePlugin({
  site: Site.LAUREL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LaurelService implements IScraper {
  private readonly logger = new Logger(LaurelService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Laurel',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Laurel: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LAUREL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'laurel-');
      }
    }

    this.logger.log(`Laurel: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
