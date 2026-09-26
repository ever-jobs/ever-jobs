import 'reflect-metadata';
import { InRecruitingService } from '../src/inrecruiting.service';
import type { InRecruitingJob } from '../src/inrecruiting.types';

describe('InRecruitingService locations', () => {
  const service = new InRecruitingService() as any;

  it('maps every JSON-LD jobLocation Place incl. streetAddress/postalCode', () => {
    const entries = service.locationEntries({
      jobLocation: [
        {
          address: {
            addressLocality: 'Milan',
            addressRegion: 'Lombardy',
            addressCountry: 'Italy',
            streetAddress: 'Via Roma 1',
            postalCode: '20121',
          },
        },
        {
          address: {
            addressLocality: 'Rome',
            addressRegion: 'Lazio',
            addressCountry: 'Italy',
          },
        },
      ],
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      city: 'Milan',
      streetAddress: 'Via Roma 1',
      postalCode: '20121',
    });
  });

  it('extractLocations carries streetAddress/postalCode into DTOs', () => {
    const job = {
      locationEntries: [
        {
          city: 'Milan',
          state: 'Lombardy',
          country: 'Italy',
          streetAddress: 'Via Roma 1',
          postalCode: '20121',
        },
        { city: 'Rome', state: 'Lazio', country: 'Italy' },
      ],
    } as unknown as InRecruitingJob;
    const locations = service.extractLocations(job);
    expect(locations).toHaveLength(2);
    expect(locations[0].streetAddress).toBe('Via Roma 1');
    expect(locations[0].postalCode).toBe('20121');
  });

  it('splitLocation delegates card free text to the shared parser', () => {
    expect(service.splitLocation(null, 'Milan, Italy')).toEqual({
      city: 'Milan',
      state: null,
      country: 'Italy',
    });
  });
});
