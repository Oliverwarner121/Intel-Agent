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
  hourly?: HourlyWeatherForecast[];
  hourlyUnavailableReason?: string;
  attribution?: { name: string; url: string; licenceUrl: string };
  warnings?: WeatherWarnings;
}

export interface HourlyWeatherForecast {
  at: string;
  summary: string;
  emoji: string;
  temperatureC: number;
  precipitationProbabilityPercent?: number;
}

export interface UnavailableWeatherLocation {
  locationId: string;
  locationName: string;
  date: string;
  unavailableReason: string;
  warnings?: WeatherWarnings;
}

export type WeatherLocationResult = WeatherForecast | UnavailableWeatherLocation;

export interface WeatherWarning {
  title: string;
  url: string;
  publishedAt: string;
}

export type WeatherWarnings =
  | { status: "ok"; region: string; checkedAt: string; warnings: WeatherWarning[] }
  | { status: "unavailable"; region: string; reason: string };
