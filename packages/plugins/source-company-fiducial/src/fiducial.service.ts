import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Fiducial — Develops on-board autonomy software for military UAVs.
 *
 * Fiducial develops and deploys software for on-board UAV autonomy in
 * military applications. The company works on guidance, navigation, and
 * control for autonomous unmanned aerial vehicles. It is based at the
 * Aerospace Innovation Hub in Delft, the Netherlands.
 *
 * Sector: Defense (UAV Autonomy). HQ: Delft, Netherlands.
 *
 * Source: Ashby job board, company slug `fiducial`
 * (`https://jobs.ashbyhq.com/fiducial`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'fiducial';
const COMPANY_NAME = 'Fiducial';

@SourcePlugin({
  site: Site.FIDUCIAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FiducialService implements IScraper {
  private readonly logger = new Logger(FiducialService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Fiducial',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Fiducial: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FIDUCIAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'fiducial-');
      }
    }

    this.logger.log(`Fiducial: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
