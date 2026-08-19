import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * NewOrbit Space — Develops spacecraft and flight software for space missions.
 *
 * NewOrbit Space is a UK-based space company developing spacecraft and
 * associated flight software. Its work spans spacecraft engineering and
 * flight software teams. The company is based in the Reading area near
 * London.
 *
 * Sector: Space. HQ: Reading, United Kingdom.
 *
 * Source: Ashby job board, company slug `neworbit`
 * (`https://jobs.ashbyhq.com/neworbit`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'neworbit';
const COMPANY_NAME = 'NewOrbit Space';

@SourcePlugin({
  site: Site.NEWORBIT_SPACE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NewOrbitSpaceService implements IScraper {
  private readonly logger = new Logger(NewOrbitSpaceService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape NewOrbit Space',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `NewOrbit Space: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NEWORBIT_SPACE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'neworbitspace-');
      }
    }

    this.logger.log(`NewOrbit Space: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
