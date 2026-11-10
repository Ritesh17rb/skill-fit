---
name: webhook-safety
description: Fix duplicate webhook payments, retries, signature validation, and idempotency problems in Node.js services.
license: MIT
---

Read references/checklist.md before editing the webhook handler. Trace event identifiers through persistence and transaction boundaries. Verify signatures before trusting payloads. Make retry processing idempotent using existing storage primitives. Preserve error handling. Add regression coverage for repeat delivery and failed first attempts.
