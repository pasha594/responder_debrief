import { describe, expect, it } from 'vitest';
import type { HistoricPerimeterFC } from '../../api/nifcHistory';
import { historicLabelPoints, labelPoint, poleOfInaccessibility } from './historicLabels';

type Feature = HistoricPerimeterFC['features'][number];

const square = (x: number, y: number, size: number): number[][] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];

function fire(
  name: string | null,
  year: number | null,
  acres: number,
  geometry: Feature['geometry'],
): Feature {
  return {
    type: 'Feature',
    geometry,
    properties: { INCIDENT: name, FIRE_YEAR_INT: year, DATE_CUR: null, GIS_ACRES: acres, IRWINID: null },
  };
}

const fc = (...features: Feature[]): HistoricPerimeterFC => ({ type: 'FeatureCollection', features });

describe('poleOfInaccessibility', () => {
  it('finds the middle of a square', () => {
    const [x, y] = poleOfInaccessibility([square(0, 0, 10)], 0.01);
    expect(x).toBeCloseTo(5, 1);
    expect(y).toBeCloseTo(5, 1);
  });

  it('stays inside a C shape, whose centroid falls in the gap', () => {
    // a 10x10 block with the middle of its east side cut out
    const c = [[0, 0], [10, 0], [10, 3], [3, 3], [3, 7], [10, 7], [10, 10], [0, 10], [0, 0]];
    const [x, y] = poleOfInaccessibility([c], 0.01);
    expect(x).toBeLessThan(3); // in the spine, not the notch
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(10);
  });

  it('keeps out of a hole', () => {
    const [x, y] = poleOfInaccessibility([square(0, 0, 10), square(3, 3, 4)], 0.01);
    const inHole = x > 3 && x < 7 && y > 3 && y < 7;
    expect(inHole).toBe(false);
  });
});

describe('labelPoint', () => {
  it('labels the largest piece of a MultiPolygon', () => {
    const at = labelPoint({
      type: 'MultiPolygon',
      coordinates: [[square(0, 40, 0.01)], [square(1, 40, 0.1)], [square(2, 40, 0.02)]],
    });
    expect(at![0]).toBeCloseTo(1.05, 2);
    expect(at![1]).toBeCloseTo(40.05, 2);
  });

  it('ignores non-polygons', () => {
    expect(labelPoint({ type: 'Point', coordinates: [1, 2] })).toBeNull();
  });
});

describe('historicLabelPoints', () => {
  it('gives each fire one label with its name and year', () => {
    const out = historicLabelPoints(
      fc(fire('Ferguson', 2018, 96831, { type: 'Polygon', coordinates: [square(-120, 37, 0.2)] })),
    );
    expect(out.features).toHaveLength(1);
    expect(out.features[0].properties).toEqual({
      name: 'Ferguson',
      year: '2018',
      acres: 96831,
      yearNum: 2018,
    });
    expect(out.features[0].geometry.coordinates[0]).toBeCloseTo(-119.9, 2);
    expect(out.features[0].geometry.coordinates[1]).toBeCloseTo(37.1, 2);
  });

  it('merges duplicate records of one fire, keeping the name that is not all caps', () => {
    const geom = { type: 'Polygon', coordinates: [square(-119.7, 37.5, 0.1)] };
    const out = historicLabelPoints(
      fc(fire('SOUTH FORK', 2017, 7564, geom), fire('South Fork', 2017, 7560, geom)),
    );
    expect(out.features).toHaveLength(1);
    expect(out.features[0].properties.name).toBe('South Fork');
  });

  it('keeps same-named fires apart when they are in different places or years', () => {
    const here = { type: 'Polygon', coordinates: [square(-120, 37, 0.05)] };
    const there = { type: 'Polygon', coordinates: [square(-119, 38, 0.05)] };
    const out = historicLabelPoints(
      fc(
        fire('Lightning', 2020, 100, here),
        fire('Lightning', 2020, 90, there),
        fire('Lightning', 2021, 80, here),
      ),
    );
    expect(out.features).toHaveLength(3);
  });

  it('labels an unnamed fire with its year alone', () => {
    const out = historicLabelPoints(
      fc(fire(null, 2019, 5, { type: 'Polygon', coordinates: [square(-120, 37, 0.01)] })),
    );
    expect(out.features[0].properties.name).toBe('');
    expect(out.features[0].properties.year).toBe('2019');
  });
});
