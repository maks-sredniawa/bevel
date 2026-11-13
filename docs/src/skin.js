try {
  const skin = JSON.parse(localStorage.getItem('retro-music-player'))?.skin;
  if (['oatmeal', 'nightshift', 'cobalt'].includes(skin)) document.documentElement.dataset.skin = skin;
} catch {}
