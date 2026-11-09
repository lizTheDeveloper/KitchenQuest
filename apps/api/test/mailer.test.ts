import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { SmtpMailer } from '../src/mail/mailer.js';

/**
 * N-1: what the SMTP mailer hands the provider. A real nodemailer stream
 * transport builds the MIME message, so the test sees exactly what would go
 * over SMTP.
 */
function streamTransport() {
  const real = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const options: object[] = [];
  const raw: string[] = [];
  return {
    options,
    raw,
    async sendMail(opts: object) {
      options.push(opts);
      const info = (await real.sendMail(opts)) as { message: Buffer };
      raw.push(info.message.toString('utf8'));
      return info;
    },
  };
}

describe('SmtpMailer (N-1)', () => {
  it('sends a single text/plain part: no HTML, no tracking pixel, nothing to rewrite', async () => {
    const t = streamTransport();
    const mailer = new SmtpMailer(t, 'Kitchen Quest <login@kitchenquest.test>');
    const link = 'https://play.kitchenquest.test/auth/verify?token=abc';
    await mailer.send({
      to: 'cook@example.com',
      subject: 'Your Kitchen Quest sign-in link',
      text: `Sign in:\n\n${link}\n`,
    });

    // Only the plain text body is passed on: no `html`, `amp`, `attachments`, `headers` or `list`.
    expect(t.options).toEqual([
      {
        from: 'Kitchen Quest <login@kitchenquest.test>',
        to: 'cook@example.com',
        subject: 'Your Kitchen Quest sign-in link',
        text: `Sign in:\n\n${link}\n`,
      },
    ]);
    const [message] = t.raw;
    const contentTypes = message.match(/^content-type:.*$/gim) ?? [];
    expect(contentTypes).toHaveLength(1);
    expect(contentTypes[0]).toMatch(/^content-type: text\/plain; charset=utf-8$/i);
    expect(message).not.toMatch(/text\/html|multipart|<img|<a\s/i);
  });
});
