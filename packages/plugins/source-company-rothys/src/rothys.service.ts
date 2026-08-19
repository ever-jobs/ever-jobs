import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Rothy\'s — Direct-to-consumer footwear and accessories brand made from recycled materials.
 *
 * Rothy's is a direct-to-consumer brand that designs and sells shoes, bags,
 * and accessories, many made using recycled plastic and other recycled
 * materials. It sells online and through its own retail stores. The company
 * is based in San Francisco.
 *
 * Sector: Retail / DTC consumer brand. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `rothys`
 * (`https://jobs.ashbyhq.com/rothys`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'rothys';
const COMPANY_NAME = 'Rothy\'s';

@SourcePlugin({
  site: Site.ROTHY_S,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RothySService implements IScraper {
  private readonly logger = new Logger(RothySService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Rothy\'s',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Rothy\'s: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ROTHY_S;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'rothys-');
      }
    }

    this.logger.log(`Rothy\'s: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
