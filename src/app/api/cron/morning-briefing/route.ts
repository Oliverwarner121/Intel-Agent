import { handleCronRequest } from "@/services/orchestration/cron-handler";

// Well below the Hobby limit; provider timeouts keep a full run inside this budget.
export const maxDuration = 60;

export function GET(request: Request): Promise<Response> {
  return handleCronRequest(request, "morning-briefing");
}
