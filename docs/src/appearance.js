try {
  const saved = JSON.parse(localStorage.getItem('retro-music-player'));
  const root = document.documentElement;
  if (typeof saved?.skin === 'string') root.dataset.skin = saved.skin;
  root.classList.toggle('compact', Boolean(saved?.compact));
  root.classList.toggle('mini', Boolean(saved?.mini));
  const titleColour = getComputedStyle(root).getPropertyValue('--title-1').trim();
  if (titleColour) document.querySelector('meta[name="theme-color"]').content = titleColour;
} catch {}
