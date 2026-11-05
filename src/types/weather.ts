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
  attribution?: { name: string; url: string; licenceUrl: string };
}

export interface UnavailableWeatherLocation {
  locationId: string;
  locationName: string;
  date: string;
  unavailableReason: string;
}

export type WeatherLocationResult = WeatherForecast | UnavailableWeatherLocation;
