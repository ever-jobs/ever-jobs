import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Talkiatry — National psychiatry practice delivering in-network virtual mental health care.
 *
 * Talkiatry is a mental health care company that provides psychiatry and
 * therapy through a nationwide network of employed clinicians. It focuses on
 * in-network, insurance-based care delivered virtually. Patients complete an
 * online assessment to be matched with a psychiatrist.
 *
 * Sector: Healthtech (mental health / telepsychiatry). HQ: New York, NY, USA.
 *
 * Source: Ashby job board, company slug `talkiatry`
 * (`https://jobs.ashbyhq.com/talkiatry`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'talkiatry';
const COMPANY_NAME = 'Talkiatry';

@SourcePlugin({
  site: Site.TALKIATRY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TalkiatryService implements IScraper {
  private readonly logger = new Logger(TalkiatryService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Talkiatry',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Talkiatry: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TALKIATRY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'talkiatry-');
      }
    }

    this.logger.log(`Talkiatry: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
