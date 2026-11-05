import { z } from "zod";
import { ConfigError, type ServerEnv } from "@/config/env";
import { HttpError, fetchJson } from "@/lib/http";
import { deliveryKey } from "@/services/delivery/delivery-key";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import { SafeError, type BriefingDelivery } from "@/types/briefing";

export function createResendDelivery(env: ServerEnv, fetchImpl?: typeof fetch): BriefingDelivery {
  return async ({ briefing, subject, template }) => {
    if (env.APP_ENV !== "prod" || env.EMAIL_SEND_ENABLED !== "true") {
      throw new SafeError("Email sending is disabled");
    }
    const { RESEND_API_KEY, EMAIL_FROM, EMAIL_TO } = env;
    if (!RESEND_API_KEY || !EMAIL_FROM || !EMAIL_TO) {
      throw new ConfigError(
        (["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_TO"] as const).filter((key) => !env[key]),
      );
    }
    const rendered = renderBriefingEmail(briefing, template);
    // Capture the exact payload once. An ambiguous outcome is never retried here.
    const body = JSON.stringify({ from: EMAIL_FROM, to: [EMAIL_TO], subject, ...rendered });
    try {
      const response = await fetchJson("https://api.resend.com/emails", z.object({ id: z.string().min(1) }), {
        retries: 0,
        timeoutMs: 10_000,
        ...(fetchImpl ? { fetchImpl } : {}),
        init: {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": deliveryKey(briefing.briefingId, briefing.reportingDate, EMAIL_TO),
          },
          body,
        },
      });
      return { messageId: response.id };
    } catch (error) {
      if (error instanceof HttpError) {
        throw new SafeError(error.status === 409
          ? "Email idempotency conflict; do not change the key or retry blindly"
          : `Email request failed (${error.message}); delivery may be uncertain, check Resend before retrying`);
      }
      throw error;
    }
  };
}
