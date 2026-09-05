// The inline player-setup script shared verbatim by the video page and the
// embed page: sets the playback-rate menu and applies the `?t=` deep link
// ("1h2m3s", "mm:ss", or bare seconds) once the player can play. Render with
// raw() inside a <script type="module">.
export const PLAYER_SETUP_SCRIPT = `customElements.whenDefined('media-video-layout').then(() => {
  const l = document.querySelector('media-video-layout');
  if (l) l.playbackRates = [0.75, 1, 1.2, 1.5, 2];
});
function parseT(v) {
  if (!v) return null;
  const hms = v.match(/^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s?)?$/);
  if (hms && (hms[1] || hms[2] || hms[3])) return (+(hms[1]||0))*3600 + (+(hms[2]||0))*60 + +(hms[3]||0);
  const col = v.match(/^(?:(\\d+):)?(\\d+):(\\d+)$/);
  if (col) return (+(col[1]||0))*3600 + (+col[2])*60 + +col[3];
  const n = parseFloat(v);
  return isFinite(n) && n >= 0 ? n : null;
}
const t = parseT(new URLSearchParams(location.search).get('t'));
if (t !== null) {
  const p = document.querySelector('media-player');
  p?.addEventListener('can-play', () => { p.currentTime = t; }, { once: true });
}`;
