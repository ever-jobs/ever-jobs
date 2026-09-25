import 'reflect-metadata';
import { IcimsService } from '../src/icims.service';
import type { IcimsListItem } from '../src/icims.types';

describe('IcimsService locations', () => {
  const service = new IcimsService() as any;

  it('parseLocations splits every | / ; cell in CC-ST-City order', () => {
    const triples = service.parseLocations('US-CA-Santa Cruz | US-NY-New York; US-TX-Austin');
    expect(triples).toEqual([
      { city: 'Santa Cruz', state: 'CA', country: 'US' },
      { city: 'New York', state: 'NY', country: 'US' },
      { city: 'Austin', state: 'TX', country: 'US' },
    ]);
  });

  it('parseLocation preserves dashes inside a city name', () => {
    expect(service.parseLocation('US-NC-Winston-Salem')).toEqual({
      city: 'Winston-Salem',
      state: 'NC',
      country: 'US',
    });
  });

  it('buildLocations emits one LocationDto per entry', () => {
    const item = {
      locationEntries: [
        { city: 'Santa Cruz', state: 'CA', country: 'US' },
        { city: 'Austin', state: 'TX', country: 'US' },
      ],
    } as IcimsListItem;
    const locations = service.buildLocations(item);
    expect(locations).toHaveLength(2);
    expect(locations[1].state).toBe('TX');
  });

  it('buildLocations falls back to the merged location / Remote', () => {
    const remote = service.buildLocations({ isRemote: true } as IcimsListItem);
    expect(remote).toHaveLength(1);
    expect(remote[0].city).toBe('Remote');
  });
});
