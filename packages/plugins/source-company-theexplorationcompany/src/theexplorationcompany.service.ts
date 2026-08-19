import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * The Exploration Company — Develops Nyx, a reusable in-orbit space vehicle and reentry capsule.
 *
 * The Exploration Company is a European space company developing Nyx, a
 * modular and reusable orbital vehicle and reentry capsule for cargo
 * transport. Its work includes thermal protection systems and atmospheric
 * reentry capabilities. The company operates across Germany and France.
 *
 * Sector: Space. HQ: Munich, Germany / Bordeaux, France.
 *
 * Source: Ashby job board, company slug `the-exploration-company`
 * (`https://jobs.ashbyhq.com/the-exploration-company`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'the-exploration-company';
const COMPANY_NAME = 'The Exploration Company';

@SourcePlugin({
  site: Site.THE_EXPLORATION_COMPANY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TheExplorationCompanyService implements IScraper {
  private readonly logger = new Logger(TheExplorationCompanyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape The Exploration Company',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `The Exploration Company: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.THE_EXPLORATION_COMPANY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'theexplorationcompany-');
      }
    }

    this.logger.log(`The Exploration Company: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
