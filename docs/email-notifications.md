# Email Notifications

## Recipient email validation

Before an email notification is dispatched, the recipient address is validated
by `NotificationService.isValidEmail` (`src/services/notification.service.ts`).
Because validated addresses flow into the SMTP/SES/SendGrid transports, the
validator is intentionally strict to prevent header- and recipient-injection.

A recipient address is **rejected** when it:

- is empty;
- contains any CR/LF or other control characters (`\x00`–`\x1f`, `\x7f`) —
  classic SMTP header injection;
- contains a comma or semicolon (multi-recipient smuggling, e.g.
  `a@b.com,c@d.com`);
- contains quoting or backslash forms (`"x"@y.com`, `a\b@c.com`);
- contains angle brackets / display-name forms (`foo<bar>@example.com`);
- does not have exactly one `@` separating a non-empty local part and a dotted
  domain with a valid TLD (e.g. `user@example` is rejected for the missing TLD).

A recipient address is **accepted** when it is a single, RFC-shaped address such
as `user@example.com` or `first.last@sub.example.co.uk`.

The validator keeps its boolean contract and is applied before any transport
dispatch, so downstream transport work can rely on its guarantees.
