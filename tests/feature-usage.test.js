const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');const {createPlansStore}=require('../plans');
test('feature counters preserve shared AI allowance and remain account scoped',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gsa-features-test-'));const s=createPlansStore(dir);
 const before=s.remainingFor('u_test','fast');
 s.recordFeatureUsage('u_test','documents');s.recordFeatureUsage('u_test','code');
 assert.equal(s.remainingFor('u_test','fast'),before);
 assert.equal(s.getFeatureUsage('u_test').documents.today,1);assert.equal(s.getFeatureUsage('u_test').code.today,1);
 assert.equal(s.getFeatureUsage('u_other').code.today,0);
 const reloaded=createPlansStore(dir);assert.equal(reloaded.getFeatureUsage('u_test').code.today,1);
 s.recordSpend('u_test','fast',{costUsd:.001});assert.ok(s.remainingFor('u_test','fast')<before);
 assert.equal(s.getFeatureUsage('u_test').code.today,1);
});
test('credit approval does not unlock paid modes and is idempotent',()=>{
 const s=createPlansStore(fs.mkdtempSync(path.join(os.tmpdir(),'gsa-payment-test-')));
 const request=s.createCreditRequest({userId:'x',email:'x@example.com',deviceId:'device',phone:'81000000',amount:2});
 s.approvePayment(request.payment.id);s.approvePayment(request.payment.id);
 assert.equal(s.getCredits('u_x').totalUsd,2);assert.equal(s.getEffectivePlan('u_x').plan,'free');assert.equal(s.checkChatAllowed('u_x','smart',4).ok,false);
});
test('declined credits cannot be approved',()=>{
 const s=createPlansStore(fs.mkdtempSync(path.join(os.tmpdir(),'gsa-payment-test-')));
 const p=s.createCreditRequest({userId:'x',email:'x@example.com',deviceId:'device',phone:'81000000',amount:2}).payment;
 s.declinePayment(p.id,{reason:'No payment'});assert.equal(s.approvePayment(p.id).ok,false);assert.equal(s.getCredits('u_x').totalUsd,0);
});
