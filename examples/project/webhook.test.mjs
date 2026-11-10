import assert from 'node:assert/strict';
import test from 'node:test';
import { processPayment } from './webhook.mjs';

test('repeated webhook delivery creates one payment', () => {
  const payments = [];
  const event = { id: 'evt_1', amount: 100 };
  processPayment(event, payments);
  processPayment(event, payments);
  assert.equal(payments.length, 1);
});
