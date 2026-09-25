import 'reflect-metadata';
import { PCRecruiterService } from '../src/pcrecruiter.service';
import type { PCRecruiterJob } from '../src/pcrecruiter.types';

describe('PCRecruiterService locations', () => {
  const service = new PCRecruiterService() as any;

  it('maps every jobLocation Place incl. streetAddress/postalCode', () => {
    const entries = service.locationEntries([
      {
        address: {
          addressLocality: 'Austin',
          addressRegion: 'TX',
          addressCountry: 'USA',
          streetAddress: '100 Main St',
          postalCode: '78701',
        },
      },
      {
        address: {
          addressLocality: 'Denver',
          addressRegion: 'CO',
          addressCountry: 'United States',
        },
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0].streetAddress).toBe('100 Main St');
  });

  it('extractLocations emits one LocationDto per entry with normalised country', () => {
    const job = {
      locationEntries: [
        {
          city: 'Austin',
          state: 'TX',
          postalCode: '78701',
          streetAddress: '100 Main St',
          country: 'USA',
        },
        { city: 'Denver', state: 'CO', postalCode: null, streetAddress: null, country: null },
      ],
    } as unknown as PCRecruiterJob;
    const locations = service.extractLocations(job);
    expect(locations).toHaveLength(2);
    expect(locations[0].country).toBe('United States');
    expect(locations[0].postalCode).toBe('78701');
  });

  it('extractLocation delegates the listing label to the shared parser', () => {
    const location = service.extractLocation({ location: 'Austin, TX 78701' } as PCRecruiterJob);
    expect(location).not.toBeNull();
    expect(location.city).toBe('Austin');
    expect(location.state).toBe('TX');
  });
});
