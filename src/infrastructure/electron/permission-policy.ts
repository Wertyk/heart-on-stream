/** Match an actual application document, allowing its query and fragment only. */
export function isAppPage(
  requestingUrl: string | undefined,
  appPages: readonly string[],
): boolean {
  if (!requestingUrl) return false;
  try {
    const url = new URL(requestingUrl);
    if (url.protocol !== "file:" || url.host !== "") return false;
    url.search = "";
    url.hash = "";
    return appPages.includes(url.href);
  } catch {
    return false;
  }
}

/** Both Electron permission handlers use this exact video-only policy. */
export function allowsVideo(
  permission: string,
  requestingUrl: string | undefined,
  mediaTypes: readonly string[] | undefined,
  appPages: readonly string[],
): boolean {
  return (
    permission === "media" &&
    mediaTypes?.length === 1 &&
    mediaTypes[0] === "video" &&
    isAppPage(requestingUrl, appPages)
  );
}
