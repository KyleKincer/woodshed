// Desktop streams signed audio through its native HTTP client. The browser
// continues fetching R2 directly; no audio passes through a cloud proxy.
export async function fetchMedia(url) {
  const localUrl=window.woodshedDesktop?.mediaUrl ? await window.woodshedDesktop.mediaUrl(url) : url;
  return fetch(localUrl);
}
