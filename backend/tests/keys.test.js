const test = require('node:test');
const assert = require('node:assert/strict');
const { keyKind, serverKeyProblem } = require('../keyValidation');
const jwt = role => `e30.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.test`;
test('a public key cannot masquerade as a configured server key', () => {
  assert.ok(serverKeyProblem('sb_publishable_example', 'sb_publishable_example'));
  assert.ok(serverKeyProblem('sb_publishable_other', 'sb_publishable_example'));
  assert.ok(serverKeyProblem(jwt('anon'), 'different-public-key'));
});
test('secret and legacy service-role keys are recognized without exposing their values', () => {
  assert.equal(keyKind('sb_secret_example'), 'secret');
  assert.equal(keyKind(jwt('service_role')), 'service_role');
  assert.equal(serverKeyProblem('sb_secret_example', 'sb_publishable_example'), '');
  assert.equal(serverKeyProblem(jwt('service_role'), jwt('anon')), '');
});
