import { describe, expect, it } from 'vitest';
import { latestWeatherRun } from './queries';
import type { WeatherRun } from './types';

const FRAMES = {
  bounds: [-125, 24.5, -66.5, 49.5] as [number, number, number, number],
  image_template: '/frames/weather/{ws}/{product}/{epoch_ms}.png',
};

function run(ws: string, renderedHours: string[] | null): WeatherRun {
  return {
    workspace: ws,
    run_time: '2026-08-18T17:00:00Z',
    hours: ['2026-08-18T17:00:00Z'],
    frames: renderedHours === null ? undefined : { ...FRAMES, hours: renderedHours, complete: false },
  };
}

describe('latestWeatherRun', () => {
  it('skips a newer run with zero rendered frames (GDAL-skipped sync)', () => {
    const weather = {
      models: { hrrr: { runs: [run('hrrr_17', []), run('hrrr_16', ['2026-08-18T16:00:00Z'])] } },
    };
    expect(latestWeatherRun(weather)?.workspace).toBe('hrrr_16');
  });

  it('treats legacy runs without a frames block as drawable', () => {
    const weather = { models: { hrrr: { runs: [run('hrrr_17', null)] } } };
    expect(latestWeatherRun(weather)?.workspace).toBe('hrrr_17');
  });

  it('falls back to the newest run when nothing is drawable', () => {
    const weather = { models: { hrrr: { runs: [run('hrrr_17', []), run('hrrr_16', [])] } } };
    expect(latestWeatherRun(weather)?.workspace).toBe('hrrr_17');
  });
});
