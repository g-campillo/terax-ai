// Canonical frontend path form is forward-slash (TERAX.md); both helpers
// stay in that form so equality checks against tab paths keep working.
export function pathToFileUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(prefixed)}`;
}

export function fileUriToPath(uri: string): string {
  const withoutScheme = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  const drive = withoutScheme.match(/^\/([A-Za-z]:\/.*)$/);
  return drive ? drive[1] : withoutScheme;
}
