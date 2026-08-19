import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Anagram — Digital assets holding company building and incubating crypto projects.
 *
 * Anagram is a digital assets holding company focused on building and
 * incubating crypto projects. It works on developing decentralized
 * technology across multiple initiatives. The company operates as a builder
 * and incubator in the crypto space.
 *
 * Sector: Crypto holding / incubation. HQ: Remote.
 *
 * Source: Ashby job board, company slug `anagram`
 * (`https://jobs.ashbyhq.com/anagram`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'anagram';
const COMPANY_NAME = 'Anagram';

@SourcePlugin({
  site: Site.ANAGRAM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AnagramService implements IScraper {
  private readonly logger = new Logger(AnagramService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Anagram',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Anagram: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ANAGRAM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'anagram-');
      }
    }

    this.logger.log(`Anagram: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
