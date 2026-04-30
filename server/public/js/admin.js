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

// --- Slug editor tools ---

// Find the slug <input> from any button inside the slug editor form.
function _slugInput(btn) {
  return btn.closest("form").querySelector('input[name="slug"]');
}

// Trigger HTMX validation after programmatically changing the input value.
function _triggerValidation(input) {
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// Prepend the video's recording date to the current slug value.
function slugPrependDate(btn) {
  var input = _slugInput(btn);
  var date = btn.dataset.date;
  if (!input.value.startsWith(date + "-")) {
    input.value = date + "-" + input.value;
    _triggerValidation(input);
  }
}

// Append a dash and 64 random alphanumeric characters to the slug.
function slugObfuscate(btn) {
  var input = _slugInput(btn);
  var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  var arr = crypto.getRandomValues(new Uint8Array(64));
  var rand = "";
  for (var i = 0; i < 64; i++) rand += chars[arr[i] % chars.length];
  input.value = input.value + "-" + rand;
  _triggerValidation(input);
}

// Fetch a generated slug from the server and replace the input value.
function slugFromTitle(btn) {
  var input = _slugInput(btn);
  var url = btn.dataset.url;
  fetch(url, { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (slug) {
      if (slug) {
        input.value = slug;
        _triggerValidation(input);
      }
    });
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
