export function statisticsResetTimestamp(data) {
  const value = new Date(data?.settings?.metricsResetAt || 0).getTime();
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function isAfterStatisticsReset(data, value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp >= statisticsResetTimestamp(data);
}
