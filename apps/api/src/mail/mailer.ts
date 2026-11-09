import nodemailer from 'nodemailer';
import type { Mailer } from '../types.js';

export type MailMessage = Parameters<Mailer['send']>[0];

/** Development mailer: writes each message to a log function (stdout by default). */
export class LogMailer implements Mailer {
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- implements Mailer.send, which returns a Promise
  async send(msg: MailMessage): Promise<void> {
    this.write(`[mail] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
  }
}

/** The part of a nodemailer transport the mailer uses; tests pass a stream transport. */
interface Transport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/**
 * Sends through an SMTP server given as a URL, e.g. `smtps://user:pass@smtp.example.com`.
 *
 * N-1: the message is a single `text/plain` part: no HTML body, so there is
 * no tracking pixel and no `<a href>` for the provider to wrap. Tracking and
 * link rewriting must also be off at the provider (`docs/compliance/mail-provider.md`);
 * provider-side rewriting of a plain-text link would hand it the token.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transport;

  constructor(
    smtp: string | Transport,
    private readonly from: string,
  ) {
    this.transport = typeof smtp === 'string' ? nodemailer.createTransport(smtp) : smtp;
  }

  async send(msg: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text });
  }
}

/** Test mailer: keeps every message in `sent`. */
export class CaptureMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- implements Mailer.send, which returns a Promise
  async send(msg: MailMessage): Promise<void> {
    this.sent.push({ ...msg });
  }
}
