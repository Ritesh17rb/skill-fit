# Webhook checklist

- Repeat delivery must not create a second payment.
- Concurrent delivery must not bypass the idempotency boundary.
- Failed processing must remain retryable.
- Invalid signatures must be rejected before business logic.
