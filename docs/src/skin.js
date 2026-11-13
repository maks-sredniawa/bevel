try {
  const skin = JSON.parse(localStorage.getItem('retro-music-player'))?.skin;
  if (typeof skin === 'string') document.documentElement.dataset.skin = skin;
} catch {}
