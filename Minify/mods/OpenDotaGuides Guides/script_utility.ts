import { fetchGuides } from "./script";

/** Settings button "Fetch Latest Guides". */
export async function fetch_guides(): Promise<void> {
  await fetchGuides();
}
