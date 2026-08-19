import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Antares (Antares Industries) — Builds factory-produced fission microreactors for strategic energy on Earth and in space.
 *
 * Antares is a nuclear energy company developing advanced, factory-produced
 * fission microreactors intended for defense, space, and commercial power.
 * Its reactor program uses TRISO fuel and is designed for transportable
 * deployment. The company has secured US government contracts and reached
 * initial criticality under a Department of Energy pilot program.
 *
 * Sector: Nuclear (Defense & Space Power). HQ: USA.
 *
 * Source: Ashby job board, company slug `antares`
 * (`https://jobs.ashbyhq.com/antares`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'antares';
const COMPANY_NAME = 'Antares (Antares Industries)';

@SourcePlugin({
  site: Site.ANTARES_ANTARES_INDUSTRIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AntaresAntaresIndustriesService implements IScraper {
  private readonly logger = new Logger(AntaresAntaresIndustriesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Antares (Antares Industries)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Antares (Antares Industries): delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ANTARES_ANTARES_INDUSTRIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'antaresantaresindustries-');
      }
    }

    this.logger.log(`Antares (Antares Industries): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
