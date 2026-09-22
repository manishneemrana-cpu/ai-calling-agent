import { registerAdapter } from "../../adapter-map";
import type {
  SendAppointmentConfirmationParams,
  SendDocumentParams,
  SendFollowUpParams,
  SendLocationParams,
  SendMediaParams,
  SendReminderParams,
  WhatsAppProvider,
  WhatsAppProviderConfig,
  WhatsAppSendResult,
} from "../types";

/**
 * InteraktWhatsAppProvider — real BSP REST API adapter.
 *
 * Per docs/VERIFICATION.md (2026-09-22 WhatsApp research) and
 * docs/STACK_PROPOSAL.md, Interakt is the recommended Phase 6 primary: an
 * official Meta Business Solution Provider with transparent published
 * per-conversation pricing and a fast small-business onboarding path,
 * appropriate for a small Indian startup's first WhatsApp integration.
 *
 * Interakt's send API (v17.0-style Cloud API passthrough, confirmed shape
 * against their public API docs) accepts a template message payload:
 *   POST {base_url}/v1/public/message/
 *   Headers: Authorization: Basic {api_key}
 *   Body: {
 *     "countryCode": "+91", "phoneNumber": "...",
 *     "type": "Template",
 *     "template": { "name": "...", "languageCode": "en",
 *                   "bodyValues": ["..."], "headerValues"?: [...] }
 *   }
 *
 * NEEDS A REAL INTERAKT/WABA ACCOUNT to smoke-test end-to-end. That is an
 * infra/business step (WhatsApp Business Account verification + template
 * approval), not a code gap — this adapter is unit-tested against a
 * dependency-injected HTTP client (same pattern as
 * telephony/adapters/plivo.ts), covering request shaping and response
 * parsing. See apps/web/tests/providers/interakt-whatsapp.test.ts.
 */

export type InteraktConfig = WhatsAppProviderConfig & {
  api_key: string;
  waba_id: string;
  base_url?: string;
};

const DEFAULT_BASE_URL = "https://api.interakt.ai";

function buildTemplatePayload(
  toNumber: string,
  templateKey: string,
  variables?: Record<string, string>,
  headerValues?: string[]
) {
  const bodyValues = variables ? Object.keys(variables).sort().map((k) => variables[k]) : [];
  const { countryCode, phoneNumber } = splitPhone(toNumber);
  return {
    countryCode,
    phoneNumber,
    type: "Template",
    template: {
      name: templateKey,
      languageCode: "en",
      bodyValues,
      ...(headerValues ? { headerValues } : {}),
    },
  };
}

function splitPhone(toNumber: string): { countryCode: string; phoneNumber: string } {
  // India-first (Phase 6 primary market): recognizes +91 E.164 explicitly
  // and otherwise defaults to +91 for a bare local number. Numbers under
  // other country codes are passed through best-effort (whole string minus
  // '+' as phoneNumber, no country code split) — full E.164 country-code
  // parsing for a multi-country tenant is scoped out of Phase 6; see
  // docs/N8N_WORKFLOWS.md / Phase 6 report for what's deferred.
  const cleaned = toNumber.replace(/[\s-]/g, "");
  if (cleaned.startsWith("+91")) {
    return { countryCode: "+91", phoneNumber: cleaned.slice(3) };
  }
  if (cleaned.startsWith("+")) {
    return { countryCode: "", phoneNumber: cleaned.slice(1) };
  }
  return { countryCode: "+91", phoneNumber: cleaned };
}

export class InteraktWhatsAppProvider implements WhatsAppProvider {
  readonly providerKey = "interakt";
  private readonly config: InteraktConfig;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: WhatsAppProviderConfig, fetchImpl: typeof fetch = fetch) {
    const cfg = config as InteraktConfig;
    if (!cfg.api_key || !cfg.waba_id) {
      throw new Error("InteraktWhatsAppProvider: config.api_key and config.waba_id are required");
    }
    this.config = cfg;
    this.baseUrl = cfg.base_url ?? DEFAULT_BASE_URL;
    this.fetchImpl = fetchImpl;
  }

  private authHeader(): string {
    return `Basic ${this.config.api_key}`;
  }

  private async send(
    toNumber: string,
    templateKey: string,
    variables?: Record<string, string>,
    headerValues?: string[]
  ): Promise<WhatsAppSendResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/public/message/`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildTemplatePayload(toNumber, templateKey, variables, headerValues)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Interakt send failed: ${res.status} ${text}`);
    }
    const body = (await res.json()) as { id?: string; messageId?: string };
    const providerMessageId = body.id ?? body.messageId ?? "";
    return { providerMessageId, status: "sent" };
  }

  async sendDocument(params: SendDocumentParams): Promise<WhatsAppSendResult> {
    return this.send(params.toNumber, params.templateKey, params.variables, [params.documentUrl]);
  }

  async sendMedia(params: SendMediaParams): Promise<WhatsAppSendResult> {
    return this.send(params.toNumber, params.templateKey, params.variables, [params.mediaUrl]);
  }

  async sendLocation(params: SendLocationParams): Promise<WhatsAppSendResult> {
    return this.send(params.toNumber, params.templateKey, {
      ...params.variables,
      __lat: String(params.latitude),
      __lng: String(params.longitude),
    });
  }

  async sendAppointmentConfirmation(params: SendAppointmentConfirmationParams): Promise<WhatsAppSendResult> {
    return this.send(params.toNumber, params.templateKey, {
      ...params.variables,
      scheduled_at: params.scheduledAtIso,
    });
  }

  async sendReminder(params: SendReminderParams): Promise<WhatsAppSendResult> {
    return this.send(params.toNumber, params.templateKey, params.variables);
  }

  async sendFollowUp(params: SendFollowUpParams): Promise<WhatsAppSendResult> {
    return this.send(params.toNumber, params.templateKey, params.variables);
  }
}

registerAdapter("whatsapp.interakt", (config) => new InteraktWhatsAppProvider(config));
