import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ZeroMark — Builds a rifle-mounted, software-defined counter-drone aiming system.
 *
 * ZeroMark develops counter-unmanned-aircraft-system technology, including
 * Apex, a rifle-mounted system that adjusts a soldier's aim in real time to
 * improve hit probability against drones. The system combines computer
 * vision and precision robotics with conventional firearms. The company was
 * founded in 2022 and has raised seed funding.
 *
 * Sector: Defense (Counter-UAS). HQ: New York, USA.
 *
 * Source: Ashby job board, company slug `zeromark`
 * (`https://jobs.ashbyhq.com/zeromark`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'zeromark';
const COMPANY_NAME = 'ZeroMark';

@SourcePlugin({
  site: Site.ZEROMARK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ZeroMarkService implements IScraper {
  private readonly logger = new Logger(ZeroMarkService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape ZeroMark',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `ZeroMark: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ZEROMARK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'zeromark-');
      }
    }

    this.logger.log(`ZeroMark: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
