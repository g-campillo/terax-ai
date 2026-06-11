// Canonical frontend path form is forward-slash (TERAX.md); both helpers
// stay in that form so equality checks against tab paths keep working.
export function pathToFileUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  // Per-segment encoding so # and ? in file names cannot truncate the URI;
  // colons stay literal for Windows drive segments (legal in path segments).
  const encoded = prefixed
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/%3A/gi, ":");
  return `file://${encoded}`;
}

export function fileUriToPath(uri: string): string {
  const withoutScheme = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  const drive = withoutScheme.match(/^\/([A-Za-z]:\/.*)$/);
  return drive ? drive[1] : withoutScheme;
}
