import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Asimov — Synthetic biology company designing genetic systems for therapeutics manufacturing.
 *
 * Asimov is a synthetic biology company that develops technologies for
 * designing genetic systems, with a focus on improving biologics and
 * cell/gene therapy manufacturing. It combines computational design tools
 * with wet-lab biology. The company is based in Boston.
 *
 * Sector: Biotech (synthetic biology). HQ: Boston, MA, USA.
 *
 * Source: Ashby job board, company slug `asimov`
 * (`https://jobs.ashbyhq.com/asimov`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'asimov';
const COMPANY_NAME = 'Asimov';

@SourcePlugin({
  site: Site.ASIMOV,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AsimovService implements IScraper {
  private readonly logger = new Logger(AsimovService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Asimov',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Asimov: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ASIMOV;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'asimov-');
      }
    }

    this.logger.log(`Asimov: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
