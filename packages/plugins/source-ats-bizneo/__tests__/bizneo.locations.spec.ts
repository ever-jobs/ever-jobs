import 'reflect-metadata';
import { BizneoService } from '../src/bizneo.service';
import type { BizneoJob } from '../src/bizneo.types';

describe('BizneoService locations', () => {
  const service = new BizneoService() as any;

  it('maps every JSON-LD jobLocation address to a triple', () => {
    const entries = service.locationEntries([
      {
        addressLocality: 'Madrid',
        addressRegion: 'Madrid',
        addressCountry: { name: 'Spain' },
      },
      {
        addressLocality: 'Malaga',
        addressRegion: 'Andalucia',
        addressCountry: 'ES',
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      city: 'Madrid',
      state: 'Madrid',
      country: 'Spain',
    });
    expect(entries[1].country).toBe('ES');
  });

  it('extractLocations emits one LocationDto per entry', () => {
    const job = {
      locationEntries: [
        { city: 'Madrid', state: 'Madrid', country: 'Spain' },
        { city: 'Malaga', state: 'Andalucia', country: 'ES' },
      ],
    } as unknown as BizneoJob;
    const locations = service.extractLocations(job);
    expect(locations).toHaveLength(2);
    expect(locations[1].city).toBe('Malaga');
  });

  it('extractLocations falls back to the merged location', () => {
    const job = { city: 'Madrid', country: 'Spain', locationEntries: [] } as unknown as BizneoJob;
    const locations = service.extractLocations(job);
    expect(locations).toHaveLength(1);
    expect(locations[0].city).toBe('Madrid');
  });

  it('splitLocation delegates free text to the shared parser', () => {
    expect(service.splitLocation('Austin, TX, US')).toEqual({
      city: 'Austin',
      state: 'TX',
      country: 'United States',
    });
    expect(service.splitLocation('Remote')).toEqual({
      city: null,
      state: null,
      country: null,
    });
  });
});
