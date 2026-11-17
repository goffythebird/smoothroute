const test = require('node:test');
const assert = require('node:assert/strict');
const { runSecretsAudit } = require('./secrets.audit');

test('Private credentials & open-source security audit passes with zero leaked secrets', () => {
  const result = runSecretsAudit();
  assert.equal(result.passed, true);
  assert.ok(result.checkedFilesCount >= 10);
});
