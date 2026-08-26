export type SecurityEmailPurpose =
  | "email_verification"
  | "password_reset"
  | "email_change"
  | "security_notice"
  | "application_outcome"
  | "creator_status"
  | "refund_status";

export type SecurityEmailMessage = Readonly<{
  handoffId: string;
  purpose: SecurityEmailPurpose;
  destination: string;
  secret: string | null;
  templateData: Readonly<Record<string, string>>;
}>;

export interface SecurityEmailSender {
  send(message: SecurityEmailMessage): Promise<void>;
}

export class DisabledSecurityEmailSender implements SecurityEmailSender {
  send(message: SecurityEmailMessage): Promise<void> {
    void message;
    return Promise.reject(new Error("Security email delivery is disabled"));
  }
}

function copyMessage(message: SecurityEmailMessage): SecurityEmailMessage {
  return Object.freeze({
    ...message,
    templateData: Object.freeze({ ...message.templateData }),
  });
}

export class DeterministicLocalSecurityEmailSink implements SecurityEmailSender {
  readonly #messages: SecurityEmailMessage[] = [];

  send(message: SecurityEmailMessage): Promise<void> {
    this.#messages.push(copyMessage(message));
    return Promise.resolve();
  }

  snapshot(): readonly SecurityEmailMessage[] {
    return Object.freeze(this.#messages.map(copyMessage));
  }
}
