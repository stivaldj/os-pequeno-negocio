/**
 * PATCH /api/v1/team/[user_id]/role — alias for the canonical
 * PATCH /api/v1/team/[user_id] (kept for EPIC-09 callers; logic in ../_shared.ts).
 */
import type { NextRequest } from "next/server";

import { changeMemberRole } from "../_shared";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  return changeMemberRole(req, ctx);
}
