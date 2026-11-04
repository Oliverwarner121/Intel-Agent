/** A single-day forecast for one configured location. */
export interface WeatherForecast {
  locationId: string;
  locationName: string;
  date: string;
  summary: string;
  temperatureMinC: number;
  temperatureMaxC: number;
  precipitationProbabilityPercent?: number;
  windSpeedMaxKph?: number;
}
