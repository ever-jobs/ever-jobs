import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * LangChain — Framework and tooling for building LLM-powered applications.
 *
 * LangChain builds open-source frameworks and commercial tooling for
 * developing applications powered by large language models, including
 * orchestration and observability products such as LangSmith.
 *
 * Sector: AI developer infrastructure. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `langchain`
 * (`https://jobs.ashbyhq.com/langchain`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'langchain';
const COMPANY_NAME = 'LangChain';

@SourcePlugin({
  site: Site.LANGCHAIN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LangChainService implements IScraper {
  private readonly logger = new Logger(LangChainService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape LangChain',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `LangChain: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LANGCHAIN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'langchain-');
      }
    }

    this.logger.log(`LangChain: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
