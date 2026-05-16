// Add the rendered cover to the video's thumbnail candidates without
// promoting it. The user promotes via the regular ThumbnailPicker on the
// video detail page.

export async function addToThumbnails(videoId: string, jpegBlob: Blob): Promise<void> {
  const fd = new FormData();
  fd.append('thumbnail', jpegBlob, 'cover.jpg');
  const res = await fetch(`/admin/videos/${videoId}/thumbnail/add-candidate`, {
    method: 'POST',
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Upload failed (${res.status})`);
  }
}
