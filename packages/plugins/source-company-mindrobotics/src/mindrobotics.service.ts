import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Mind Robotics — Develops dexterous physical AI robotic systems for industrial manipulation tasks.
 *
 * Mind Robotics develops physical AI systems, building dexterous robotic
 * hardware with tactile sensing, real-time control, and machine learning
 * trained on demonstration data for real-world industrial work. Most roles
 * are based in Palo Alto, California, with a deployment role in Normal,
 * Illinois.
 *
 * Sector: Robotics / Physical AI. HQ: Palo Alto, California, USA.
 *
 * Source: Ashby job board, company slug `mindrobotics`
 * (`https://jobs.ashbyhq.com/mindrobotics`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'mindrobotics';
const COMPANY_NAME = 'Mind Robotics';

@SourcePlugin({
  site: Site.MIND_ROBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MindRoboticsService implements IScraper {
  private readonly logger = new Logger(MindRoboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Mind Robotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Mind Robotics: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MIND_ROBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'mindrobotics-');
      }
    }

    this.logger.log(`Mind Robotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
