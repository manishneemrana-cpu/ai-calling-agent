/**
 * WhatsAppProvider — the adapter contract every WhatsApp BSP/API provider
 * implements. Same Provider Registry pattern as
 * apps/web/lib/providers/telephony/types.ts (Phase 2) and the
 * stt/tts/llm/embedding layers (Phase 3/3.5) — see docs/PROVIDER_REGISTRY.md.
 *
 * Multi-industry / generalization note (Phase 6): the original master spec
 * named real-estate-flavored methods (sendProjectDetails,
 * sendPropertyImages, sendBrochure, sendSiteVisitConfirmation). Per the
 * multi-industry pivot (see docs/PROMPT_TO_AGENT_BUILDER.md), this
 * interface instead exposes generic verbs — sendDocument, sendMedia,
 * sendLocation, sendAppointmentConfirmation, sendReminder, sendFollowUp —
 * with the real-estate flavor (brochure copy, project-detail templates)
 * living purely in a tenant's `template_key` + `variables` config, never in
 * a method name or adapter code path.
 *
 * Business logic must depend ONLY on this interface, obtained via
 * `getWhatsAppProvider()` in apps/web/lib/providers/registry.ts — never a
 * concrete adapter class, never a switch/if-else on providerKey.
 */

export type WhatsAppSendResult = {
  /** The provider's own message id, for delivery-status correlation. */
  providerMessageId: string;
  status: "queued" | "sent" | "failed";
};

export type WhatsAppSendBase = {
  toNumber: string;
  orgId: string;
  /** Tenant-owned approved template name/key (Meta requires pre-approved
   * templates for business-initiated messages outside a 24h session
   * window) — never a hardcoded template string in adapter code. */
  templateKey: string;
  /** Template variable substitutions, e.g. {"1": "Ramesh", "2": "3 PM"}. */
  variables?: Record<string, string>;
};

export type SendDocumentParams = WhatsAppSendBase & {
  documentUrl: string;
  fileName?: string;
  caption?: string;
};

export type SendMediaParams = WhatsAppSendBase & {
  mediaUrl: string;
  mediaType: "image" | "video";
  caption?: string;
};

export type SendLocationParams = WhatsAppSendBase & {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

export type SendAppointmentConfirmationParams = WhatsAppSendBase & {
  appointmentId: string;
  scheduledAtIso: string;
  locationOrLink?: string;
};

export type SendReminderParams = WhatsAppSendBase & {
  appointmentId?: string;
  bodyContext?: Record<string, string>;
};

export type SendFollowUpParams = WhatsAppSendBase & {
  leadId: string;
  bodyContext?: Record<string, string>;
};

export interface WhatsAppProvider {
  /** Stable key matching `providers.provider_key`. */
  readonly providerKey: string;

  sendDocument(params: SendDocumentParams): Promise<WhatsAppSendResult>;
  sendMedia(params: SendMediaParams): Promise<WhatsAppSendResult>;
  sendLocation(params: SendLocationParams): Promise<WhatsAppSendResult>;
  sendAppointmentConfirmation(params: SendAppointmentConfirmationParams): Promise<WhatsAppSendResult>;
  sendReminder(params: SendReminderParams): Promise<WhatsAppSendResult>;
  sendFollowUp(params: SendFollowUpParams): Promise<WhatsAppSendResult>;
}

export type WhatsAppProviderConfig = Record<string, unknown>;
