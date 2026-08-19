import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Mach Industries — Designs and manufactures defense hardware and weapons systems.
 *
 * Mach Industries is a defense manufacturing company developing and
 * producing hardware and systems for military applications. The company
 * deploys products aimed at supporting US and allied defense capabilities.
 * It operates across engineering and manufacturing functions.
 *
 * Sector: Defense. HQ: Huntington Beach, California, USA.
 *
 * Source: Ashby job board, company slug `mach`
 * (`https://jobs.ashbyhq.com/mach`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'mach';
const COMPANY_NAME = 'Mach Industries';

@SourcePlugin({
  site: Site.MACH_INDUSTRIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MachIndustriesService implements IScraper {
  private readonly logger = new Logger(MachIndustriesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Mach Industries',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Mach Industries: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MACH_INDUSTRIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'machindustries-');
      }
    }

    this.logger.log(`Mach Industries: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
