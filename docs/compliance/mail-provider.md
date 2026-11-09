# Mail provider settings (N-1)

**Item:** N-1 (risk register §6; risks R-06, R-28). **Status:** the provider is not chosen yet (`processors.json`: "Mail provider (TBD)"). These settings are requirements for whichever provider is picked; check each one before `MAILER=smtp` points at it in production, and record the provider, its DPA and its region in `processors.json` (P-11, N-9).

A magic link is a credential for 15 minutes. Whoever can read or rewrite the email can sign in as the player, so the provider must be treated as holding a password, and must learn nothing about the player beyond the address.

## What the API sends

`SmtpMailer` (`apps/api/src/mail/mailer.ts`) sends one `text/plain; charset=utf-8` part with a from address, a to address, a subject and a text body. No HTML part, so no tracking pixel and no `<a href>` to wrap; no attachments, no custom headers, no `List-Unsubscribe` (it is not a marketing message). The sign-in email holds exactly one URL, `APP_ORIGIN/auth/verify?token=…`, and no health content: no rule, allergy, diet, consent or profile detail. `apps/api/test/mailer.test.ts` and `apps/api/test/auth.test.ts` check both.

## Provider settings

| Setting                                                 | Required value                                                                                                               | Why                                                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Open tracking                                           | **Off** for the account, or for the sending stream/domain used for sign-in                                                   | A tracking pixel is only possible in HTML, which we never send; some providers convert plain text to HTML to add one, so turn it off explicitly |
| Click tracking                                          | **Off**                                                                                                                      | Click tracking rewrites the link through the provider's redirect, so the provider sees (and logs) every token                                   |
| Link rewriting / link branding / "auto-link"            | **Off**                                                                                                                      | Same as click tracking: the token must reach the player byte for byte, and only our origin                                                      |
| Plain text to HTML conversion                           | **Off**                                                                                                                      | Keeps the message the single text part the API sent                                                                                             |
| Message content retention (the stored copy of the body) | **Off**, or the shortest the provider allows (≤ 3 days)                                                                      | The body holds a live credential                                                                                                                |
| Delivery and event log retention                        | **≤ 30 days** (A-10)                                                                                                         | Logs hold the recipient address                                                                                                                 |
| Suppression list (bounces, complaints)                  | Allowed; deleted for an address on account delete through the processor-deletion queue (C-8)                                 | The list holds the address after the account is gone                                                                                            |
| Analytics, marketing lists, contact sync                | **Off**; no contact or audience records are created                                                                          | We send transactional mail only                                                                                                                 |
| Sending domain: SPF                                     | Record that authorises only the provider's servers for the sending domain, ending `-all`                                     | Stops others sending as us                                                                                                                      |
| Sending domain: DKIM                                    | Signing on, 2048-bit key, with the selector published in DNS                                                                 | Lets receivers check the message was not altered                                                                                                |
| Sending domain: DMARC                                   | `p=reject` (start at `p=quarantine` while checking reports), `adkim=s; aspf=s`, aggregate reports (`rua`) to our own mailbox | Phishing a sign-in link is the obvious attack; receivers must reject spoofed mail                                                               |
| TLS                                                     | Required for SMTP submission (`smtps://` or STARTTLS required) and, where offered, enforced TLS to recipient servers         | The body is a credential in transit                                                                                                             |
| Region                                                  | EU where offered; otherwise list the transfer basis in `processors.json`                                                     | GDPR Ch. V                                                                                                                                      |
| DPA                                                     | Signed before the first production send                                                                                      | GDPR Art. 28; no processor call is merged while its DPA is unknown (N-9)                                                                        |

## Checks before go-live

- Send a sign-in email to a test inbox and read the raw source: one `text/plain` part, the link unchanged (our origin, not a provider redirect), no tracking image.
- Confirm SPF, DKIM and DMARC pass in the received headers (`Authentication-Results`).
- Record the retention settings and the date checked in `processors.json` against the provider entry.
- Re-check after any change of provider, plan or sending domain.
