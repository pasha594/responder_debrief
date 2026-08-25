import { describe, expect, it } from 'vitest';
import { parseCoordinateInput } from './geocode';

describe('parseCoordinateInput', () => {
  it('parses lat-first pairs into [lon, lat]', () => {
    expect(parseCoordinateInput('48.016, -120.846')).toEqual([-120.846, 48.016]);
    expect(parseCoordinateInput('48.016 -120.846')).toEqual([-120.846, 48.016]);
    expect(parseCoordinateInput(' 37.5;-119.2 ')).toEqual([-119.2, 37.5]);
  });

  it('flips pairs that only make sense lon-first', () => {
    expect(parseCoordinateInput('-120.846, 48.016')).toEqual([-120.846, 48.016]);
  });

  it('rejects non-coordinates', () => {
    expect(parseCoordinateInput('big grass')).toBeNull();
    expect(parseCoordinateInput('200, 300')).toBeNull();
    expect(parseCoordinateInput('48')).toBeNull();
  });
});
