// Admin client-side JS. Handles the few interactions that can't be done
// server-side: clipboard copy, <dialog> management, file upload progress.
// Deliberately minimal — most interactivity is HTMX + server partials.

// Copy text to clipboard. Called from onclick handlers on "Copy URL" buttons.
function copyToClipboard(text) {
  const fullUrl = window.location.origin + text;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(fullUrl);
  } else {
    prompt("Copy this URL:", fullUrl);
  }
}

// Upload progress handler. Called via hx-on:htmx:xhr:progress on the
// upload form. Updates the <progress> element.
function updateProgress(event) {
  const bar = document.querySelector(".upload-progress-bar");
  if (bar && event.detail.loaded && event.detail.total) {
    const pct = Math.round((event.detail.loaded / event.detail.total) * 100);
    bar.value = pct;
  }
}
