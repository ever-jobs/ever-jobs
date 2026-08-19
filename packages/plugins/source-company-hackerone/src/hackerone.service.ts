import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * HackerOne — Security platform connecting organizations with a community of security researchers.
 *
 * HackerOne operates a security platform that connects organizations with
 * external security researchers for vulnerability disclosure, bug bounty
 * programs, and penetration testing. Its infrastructure supports coordinated
 * vulnerability reporting at scale.
 *
 * Sector: Security / Developer infrastructure. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `hackerone`
 * (`https://jobs.ashbyhq.com/hackerone`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'hackerone';
const COMPANY_NAME = 'HackerOne';

@SourcePlugin({
  site: Site.HACKERONE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HackerOneService implements IScraper {
  private readonly logger = new Logger(HackerOneService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape HackerOne',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `HackerOne: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HACKERONE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'hackerone-');
      }
    }

    this.logger.log(`HackerOne: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
