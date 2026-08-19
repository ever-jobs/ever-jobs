import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Saronic Technologies — Develops autonomous surface vessels and maritime autonomy systems for defense.
 *
 * Saronic Technologies designs and builds autonomous surface vessels and the
 * software that operates them, focused on maritime defense missions. The
 * company develops intelligent platforms intended to enhance naval and
 * maritime operations. It operates its own shipyard and production
 * engineering functions.
 *
 * Sector: Defense (Maritime Autonomy). HQ: Austin, Texas, USA.
 *
 * Source: Ashby job board, company slug `saronic`
 * (`https://jobs.ashbyhq.com/saronic`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'saronic';
const COMPANY_NAME = 'Saronic Technologies';

@SourcePlugin({
  site: Site.SARONIC_TECHNOLOGIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SaronicTechnologiesService implements IScraper {
  private readonly logger = new Logger(SaronicTechnologiesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Saronic Technologies',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Saronic Technologies: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SARONIC_TECHNOLOGIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'saronictechnologies-');
      }
    }

    this.logger.log(`Saronic Technologies: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
