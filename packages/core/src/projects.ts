/**
 * A repository one syl server is pointed at. The server can hold several at
 * once, and every request names the one it is about, so this is the shape both
 * ends agree on: the id is what travels in `?project=`, the rest is what the
 * switcher shows.
 */
export interface ProjectSummary {
  /** Stable, URL-safe handle — derived from the directory name when added. */
  id: string;
  /** Directory name, shown in the UI. */
  name: string;
  /** Absolute path to the checkout. */
  root: string;
}
