import { randomUUID } from "crypto";
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
 * MockWhatsAppProvider — deterministic, in-memory fake. No network calls.
 * Used for demo mode and the whole test suite, same role as
 * MockTelephonyProvider (Phase 2). Records every call so tests can assert
 * on what was "sent" without a real WhatsApp Business Account.
 */

export type MockSentMessage = {
  id: string;
  method: string;
  toNumber: string;
  templateKey: string;
  variables?: Record<string, string>;
};

const sent: MockSentMessage[] = [];

function ok(method: string, toNumber: string, templateKey: string, variables?: Record<string, string>): WhatsAppSendResult {
  const id = `mock_wa_${randomUUID()}`;
  sent.push({ id, method, toNumber, templateKey, variables });
  return { providerMessageId: id, status: "sent" };
}

export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly providerKey = "mock";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: WhatsAppProviderConfig = {}) {}

  async sendDocument(params: SendDocumentParams): Promise<WhatsAppSendResult> {
    return ok("sendDocument", params.toNumber, params.templateKey, params.variables);
  }

  async sendMedia(params: SendMediaParams): Promise<WhatsAppSendResult> {
    return ok("sendMedia", params.toNumber, params.templateKey, params.variables);
  }

  async sendLocation(params: SendLocationParams): Promise<WhatsAppSendResult> {
    return ok("sendLocation", params.toNumber, params.templateKey, params.variables);
  }

  async sendAppointmentConfirmation(params: SendAppointmentConfirmationParams): Promise<WhatsAppSendResult> {
    return ok("sendAppointmentConfirmation", params.toNumber, params.templateKey, params.variables);
  }

  async sendReminder(params: SendReminderParams): Promise<WhatsAppSendResult> {
    return ok("sendReminder", params.toNumber, params.templateKey, params.variables);
  }

  async sendFollowUp(params: SendFollowUpParams): Promise<WhatsAppSendResult> {
    return ok("sendFollowUp", params.toNumber, params.templateKey, params.variables);
  }

  /** Test-only: inspect everything "sent" so far. */
  static _sentForTests(): MockSentMessage[] {
    return sent;
  }

  /** Test-only: reset in-memory state between test files/runs. */
  static _resetForTests(): void {
    sent.length = 0;
  }
}

registerAdapter("whatsapp.mock", (config) => new MockWhatsAppProvider(config));
