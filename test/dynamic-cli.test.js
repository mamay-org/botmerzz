'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { providerConnectionStatus } = require('../src/cli');

test('provider status is connected only with confirmed active unsuspended matching account', () => {
  const effective = { profileId:'profile', accountId:'account' };
  const target = { id:'account', profileId:'profile', platform:'threads', status:'active', planSuspended:false };
  assert.equal(providerConnectionStatus([target],effective).connected,true);
  for (const change of [{planSuspended:null},{planSuspended:undefined},{planSuspended:true},{profileId:'other'},{status:'expired'},{platform:'instagram'}]) {
    assert.equal(providerConnectionStatus([{...target,...change}],effective).connected,false);
  }
});
