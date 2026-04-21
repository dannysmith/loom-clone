// Admin client-side JS. Handles the few interactions that can't be done
// server-side: clipboard copy, <dialog> management, file upload progress.
// Deliberately minimal — most interactivity is HTMX + server partials.

// Copy text to clipboard. Called from onclick handlers on "Copy URL" buttons.
// Uses the modern Clipboard API; falls back to a prompt on older browsers.
function copyToClipboard(text) {
  const fullUrl = window.location.origin + text;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(fullUrl);
  } else {
    prompt("Copy this URL:", fullUrl);
  }
}
