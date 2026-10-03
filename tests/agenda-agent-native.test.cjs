const { test } = require('node:test');
const { nativeAgendaFixture } = require('./helpers/agenda-native-fixture.cjs');
test('authoritative native agenda query and reviewed mutations', { skip: process.platform !== 'darwin', timeout: 120000 }, t => {
  console.log(nativeAgendaFixture(t).stdout.trim());
});
