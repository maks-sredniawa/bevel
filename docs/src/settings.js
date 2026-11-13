export const SKINS = [['oatmeal', 'Oatmeal'], ['nightshift', 'Night shift'], ['cobalt', 'Cobalt']];

export function mergeSettings(defaults, saved) {
  const merged = { ...defaults, ...saved, eq: { ...defaults.eq, ...saved?.eq } };
  if (!SKINS.some(([skin]) => skin === merged.skin)) merged.skin = defaults.skin;
  return merged;
}
