// Admin client-side JS. Handles the few interactions that can't be done
// server-side: clipboard copy, <dialog> management, file upload progress.
// Deliberately minimal — most interactivity is HTMX + server partials.

// Copy a URL path to clipboard (prepends the current origin).
function copyToClipboard(text) {
  const fullUrl = window.location.origin + text;
  copyText(fullUrl);
}

// Copy raw text to clipboard.
function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text);
  } else {
    prompt("Copy:", text);
  }
}

// Open the file preview dialog and run syntax highlighting.
function openFilePreview() {
  var dialog = document.getElementById("file-preview-dialog");
  if (dialog) dialog.showModal();
  document.querySelectorAll("#file-preview-content pre code").forEach(function (el) {
    if (window.hljs) hljs.highlightElement(el);
  });
}

// Auto-open preview dialog when file content is swapped in.
document.body.addEventListener("htmx:afterSwap", function (event) {
  if (event.detail.target && event.detail.target.id === "file-preview-content") {
    openFilePreview();
  }
});

// Upload progress handler. Called via hx-on:htmx:xhr:progress on the
// upload form. Updates the <progress> element.
function updateProgress(event) {
  const bar = document.querySelector(".upload-progress-bar");
  if (bar && event.detail.loaded && event.detail.total) {
    const pct = Math.round((event.detail.loaded / event.detail.total) * 100);
    bar.value = pct;
  }
}
