import "server-only";

import { supabase } from "@/lib/supabase/server";

/** Storage lists at most 1,000 names per call. */
const PAGE = 1000;

/**
 * Every file name in a bucket folder (optionally starting with `search`),
 * page by page: one list call stops at 1,000, so deleting a big campaign
 * with a single call would leave the rest behind.
 */
export async function listAll(bucket: string, folder: string, search?: string): Promise<string[]> {
  const names: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase()
      .storage.from(bucket)
      .list(folder, { limit: PAGE, offset, ...(search && { search }) });
    if (error) throw error;
    names.push(...(data ?? []).map((f) => f.name));
    if ((data?.length ?? 0) < PAGE) return names;
  }
}

/** Removes files (full paths) in batches the API accepts. */
export async function removeAll(bucket: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += PAGE) {
    const { error } = await supabase().storage.from(bucket).remove(paths.slice(i, i + PAGE));
    if (error) throw error;
  }
}
