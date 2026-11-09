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

/** Sends through an SMTP server given as a URL, e.g. `smtps://user:pass@smtp.example.com`. */
export class SmtpMailer implements Mailer {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
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
