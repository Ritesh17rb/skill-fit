// Deliberately incomplete retry handling for the demo task.
export function processPayment(event, payments) {
  payments.push({ eventId: event.id, amount: event.amount });
}
