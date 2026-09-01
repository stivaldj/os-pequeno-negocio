/**
 * PATCH /api/v1/team/[user_id] — change a member's role (canonical, G2-02).
 * Logic lives in ./_shared.ts (shared with the /role alias from EPIC-09).
 */
import type { NextRequest } from "next/server";

import { changeMemberRole } from "./_shared";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  return changeMemberRole(req, ctx);
}
