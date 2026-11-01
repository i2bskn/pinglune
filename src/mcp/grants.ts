import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Revokes every OAuth grant of the user, with their tokens. Errors propagate (500); running it
// again revokes what is left. KV is eventually consistent, so a grant created in another location
// within about 60 seconds may not be listed yet.
export async function revokeAllGrants(oauth: OAuthHelpers, userId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, cursor === undefined ? undefined : { cursor });
    await Promise.all(page.items.map((grant) => oauth.revokeGrant(grant.id, userId)));
    cursor = page.cursor;
  } while (cursor);
}
