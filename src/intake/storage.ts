import { describeError } from "../auth/middleware";

// R2 deletes up to 1,000 keys per call.
const R2_DELETE_BATCH = 1000;

export function workspacePrefix(workspaceId: string): string {
  return `workspaces/${workspaceId}/`;
}

// The R2 key of the body or an attachment of an event.
export function eventDataKey(workspaceId: string, eventId: string, dataRef: string): string {
  return `${workspacePrefix(workspaceId)}events/${eventId}/${dataRef}`;
}

// Deletes every object of a workspace, including orphans left by failed intakes. Best effort: failures are
// logged and the rest is skipped.
export async function deleteWorkspaceObjects(bucket: R2Bucket, workspaceId: string): Promise<void> {
  const prefix = workspacePrefix(workspaceId);
  try {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const listed = await bucket.list({ prefix, cursor });
      for (const object of listed.objects) keys.push(object.key);
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
    for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
      await bucket.delete(keys.slice(i, i + R2_DELETE_BATCH));
    }
  } catch (error) {
    console.error("deleting the objects of a workspace failed", { workspaceId, ...describeError(error) });
  }
}
