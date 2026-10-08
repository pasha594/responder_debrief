/**
 * When the PyreCast credit chip is due. Mirrors spreadForecastLayer's own
 * draw condition: in fire mode, the layer is painted whenever it is switched
 * on and the fire has a run — whether or not the Forecast tab is open (the
 * LegendBar's legend key is set only while that tab is mounted, so it is
 * not the right gate for a credit that must accompany the pixels).
 */
export function spreadCreditVisible(input: {
  fireMode: boolean;
  spreadVisible: boolean;
  hasRun: boolean;
}): boolean {
  return input.fireMode && input.spreadVisible && input.hasRun;
}

/** The citation PyreCast asks for, used as the chip's accessible title. */
export const PYRECAST_CITATION =
  'Fire forecast data: PyreCast Wildfire Forecasting Platform (pyrecast.org)';

export const PYRECAST_URL = 'https://pyrecast.org';

/** Pyregence, the consortium behind PyreCast: cited by the Fire Forecast heading. */
export const PYREGENCE_CITATION =
  'Fire forecasts from Pyregence Open-Source Fire Science (pyregence.org)';

export const PYREGENCE_URL = 'https://www.pyregence.org';
