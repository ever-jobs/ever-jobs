import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * BRINC — Builds drones and communication devices for emergency and public safety response.
 *
 * BRINC develops drones and ruggedized communication devices for public
 * safety, including a drone-as-first-responder network dispatched to 911
 * calls to provide real-time visual data. Its solutions are used by public
 * safety agencies across the United States. It is headquartered in Seattle,
 * Washington.
 *
 * Sector: Drones / Public safety. HQ: Seattle, Washington, USA.
 *
 * Source: Ashby job board, company slug `brinc`
 * (`https://jobs.ashbyhq.com/brinc`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'brinc';
const COMPANY_NAME = 'BRINC';

@SourcePlugin({
  site: Site.BRINC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BRINCService implements IScraper {
  private readonly logger = new Logger(BRINCService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape BRINC',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `BRINC: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BRINC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'brinc-');
      }
    }

    this.logger.log(`BRINC: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
