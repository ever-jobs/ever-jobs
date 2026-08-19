import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Aspora — A cross-border financial platform for the non-resident Indian diaspora.
 *
 * Aspora, founded in 2022, builds a cross-border financial operating system
 * serving the non-resident Indian (NRI) diaspora, offering money transfers
 * and bill payments to India through regulated entities and partnerships. It
 * is backed by investors including Sequoia Capital, Greylock, Hummingbird, Y
 * Combinator, and Global Founders Capital.
 *
 * Sector: Fintech - Remittance & cross-border banking. HQ: USA / India.
 *
 * Source: Ashby job board, company slug `aspora`
 * (`https://jobs.ashbyhq.com/aspora`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'aspora';
const COMPANY_NAME = 'Aspora';

@SourcePlugin({
  site: Site.ASPORA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AsporaService implements IScraper {
  private readonly logger = new Logger(AsporaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Aspora',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Aspora: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ASPORA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'aspora-');
      }
    }

    this.logger.log(`Aspora: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
